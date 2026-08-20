import {
  ELEVATE_LABEL,
  FLEET_LABELS,
  LIGHT_LABEL,
  type PlanResult,
  type ProjectConfig,
  type TicketRecord,
} from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import {
  bodyWithChildTaskList,
  bodyWithDependsOn,
  bodyWithPartOf,
  createIssue,
  createPullRequest,
  escalateToElevated,
  findChildIssues,
  findOpenPrUrlForBranch,
  getIssue,
  parseChildTaskList,
  swapLabel,
  updateIssueBody,
  upsertStatusComment,
  type ReadyIssue,
} from "../github/github.ts";
import { Journal } from "../store/journal.ts";
import { log, logError } from "../log.ts";
import { hasCommits, pushBranch } from "../github/worktree.ts";
import { gatherFailurePostMortem } from "./postmortem.ts";
import { issueUrl, notify } from "../notify.ts";

const PR_FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

/**
 * Marks an error as coming from the push/PR/label pipeline that runs *after*
 * the worker already produced a `completed` result — commits exist, the model
 * did its job. `shouldAutoElevate`'s caller must never retry these on a
 * stronger model: re-running the whole ticket cannot fix a git or GitHub API
 * problem, it can only redo already-merged work or hit the identical
 * rejection again.
 */
export class PostCompletionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PostCompletionError";
  }
}

/** The status-comment line for a ticket's machine-review outcome; undefined when no review was attempted. */
export function machineReviewLine(outcome: TicketRecord["machineReviewOutcome"]): string | undefined {
  switch (outcome) {
    case "passed":
      return "Machine review: passed";
    case "findings":
      return "Machine review: found issues — addressed in a fix round";
    case "skipped":
    case "pending":
      return "Machine review: skipped (reviewer unavailable)";
    default:
      return undefined;
  }
}

/**
 * Whether a failed run should be auto-escalated to the elevated model instead of
 * parking the ticket in `fleet:needs-input`: the project must have an elevated
 * model configured, opt in (default), and this must be the ticket's first
 * failure at any tier — a manually- or already auto-elevated run that fails
 * again gets the normal needs-input treatment so escalation only ever fires once.
 *
 * No record means the failure happened before the claim-phase upsert (label
 * swap, assignee CAS, worktree setup) — infrastructure a stronger model can't
 * fix, and with no record the `autoElevated: true` write-back would silently
 * no-op, turning "once" into an unbounded claim→fail→escalate loop. Those
 * failures park in `fleet:needs-input` for a human instead.
 */
export function shouldAutoElevate(
  project: { elevatedModel?: string; autoElevateOnFailure?: boolean },
  record: { elevated?: boolean; autoElevated?: boolean } | undefined,
): boolean {
  if (!record) return false;
  if (!project.elevatedModel) return false;
  if (project.autoElevateOnFailure === false) return false;
  if (record.elevated) return false;
  if (record.autoElevated) return false;
  return true;
}

/** The tail every successful turn shares: status comment → label swap → state update → board → log. */
async function moveToReview(
  ctx: LoopContext,
  project: ProjectConfig,
  issueNumber: number,
  opts: { comment: string; update: Partial<TicketRecord>; logLine: string },
): Promise<void> {
  const scope = key(project.name, issueNumber);
  try {
    await upsertStatusComment(project, issueNumber, opts.comment);
  } catch (err) {
    logError("loop", `${scope}: could not post the review status comment`, err);
  }
  await swapLabel(project, issueNumber, FLEET_LABELS.inProgress, FLEET_LABELS.review);
  ctx.state.update(project.name, issueNumber, { status: "review", ...opts.update });
  ctx.emitBoard();
  log("loop", `${scope}: ${opts.logLine}`);
}

export async function finishCompleted(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: ReadyIssue,
  worktreePath: string,
  branch: string,
  summary: string,
  result: { prTitle?: string; prBody?: string; filesChanged: string[]; confidence: string },
): Promise<void> {
  if (!(await hasCommits(project, worktreePath))) {
    await finishBlocked(ctx, project, issue, "Worker reported completed but made no commits.", summary);
    return;
  }
  try {
    await pushBranch(worktreePath, branch);
    const prBody = [
      result.prBody ?? summary,
      `Closes #${issue.number}`,
      PR_FOOTER,
    ].join("\n\n");
    const record = ctx.state.get(project.name, issue.number);
    let prUrl = record?.prUrl;
    if (!prUrl) {
      try {
        prUrl = await createPullRequest(project, branch, result.prTitle ?? issue.title, prBody);
      } catch (err) {
        // A PR can already exist when a previous completion created it but the
        // record write was lost (crash, restart cleanup failure) — adopt it
        // rather than dead-ending every retry on "already exists".
        if (/already exists/i.test(err instanceof Error ? err.message : String(err))) {
          prUrl = await findOpenPrUrlForBranch(project, branch);
        }
        if (!prUrl) throw err;
        log("loop", `${key(project.name, issue.number)}: adopted existing open PR ${prUrl} for ${branch}`);
      }
      // Persisted before the label swap below: a swap failure must not orphan
      // the PR from the record, or the retry re-creates instead of reusing.
      ctx.state.update(project.name, issue.number, { prUrl });
    }
    await moveToReview(ctx, project, issue.number, {
      comment: [
        `**Status: ready for review** (confidence: ${result.confidence})`,
        summary,
        machineReviewLine(record?.machineReviewOutcome),
        result.filesChanged.length > 0 ? `Files changed:\n${result.filesChanged.map((f) => `- \`${f}\``).join("\n")}` : "",
        prUrl ? `PR: ${prUrl}` : "",
      ].filter(Boolean).join("\n\n"),
      update: { prUrl, lastSummary: summary },
      logLine: `PR ${prUrl}`,
    });
    await notify(ctx, "pr-opened", project, { issueNumber: issue.number, title: result.prTitle ?? issue.title, detail: summary, url: prUrl });
  } catch (err) {
    throw new PostCompletionError(
      `the worker completed successfully (commits exist on \`${branch}\`) but the push/PR pipeline failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}

/**
 * Resolves one ticket's `dependsOnIndex` against `tickets[]`'s own indices.
 * Only a reference to a strictly earlier index is honored — children file in
 * array order, so a sibling at `index` or later has no issue number yet, and
 * honoring it would either deadlock (self) or be unfileable (forward). Pure
 * so the index math is testable without touching `createIssue`.
 */
export function resolveDependsOnIndex(
  index: number,
  dependsOnIndex: number[] | undefined,
  totalTickets: number,
): { valid: number[]; dropped: number[] } {
  const valid: number[] = [];
  const dropped: number[] = [];
  for (const idx of dependsOnIndex ?? []) {
    if (Number.isInteger(idx) && idx >= 0 && idx < totalTickets && idx < index) {
      if (!valid.includes(idx)) valid.push(idx);
    } else {
      dropped.push(idx);
    }
  }
  return { valid, dropped };
}

/**
 * A completed plan never pushes or opens a PR — it files child issues instead,
 * `fleet:ready` only when the project opts in via `planChildrenReady`, and puts
 * the epic itself straight into `fleet:review` for a human to curate.
 */
export async function finishPlanned(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: ReadyIssue,
  result: PlanResult,
): Promise<void> {
  const autoReady = project.planChildrenReady;

  // Filing is not idempotent (createIssue per child), so gate on GitHub, the
  // source of truth: a re-completed plan whose children already exist — from a
  // crash mid-filing or a transient failure after filing — must not file a
  // second batch. A re-run planner words its tickets differently, so presence
  // of *any* prior child is the signal, not title matching. The epic ends in
  // fleet:review either way; a partially-filed batch is the human's call.
  const alreadyFiled = await hasExistingChildren(project, issue);
  if (alreadyFiled) {
    log("loop", `${key(project.name, issue.number)}: children already filed for this epic — skipping filing, moving to review`);
    const record = ctx.state.get(project.name, issue.number);
    await moveToReview(ctx, project, issue.number, {
      comment: [
        `**Status: planned** (confidence: ${result.confidence})`,
        result.summary,
        machineReviewLine(record?.machineReviewOutcome),
        "This plan re-completed after its children were already filed — no new issues were created. Review the existing children against the summary above.",
      ].filter(Boolean).join("\n\n"),
      update: { lastSummary: result.summary },
      logLine: "planned (children already filed)",
    });
    return;
  }

  const created: { number: number; url: string; title: string }[] = [];
  const droppedNotes: string[] = [];
  for (const [index, ticket] of result.tickets.entries()) {
    const tierLabel = ticket.tier === "light" ? LIGHT_LABEL : ticket.tier === "elevated" ? ELEVATE_LABEL : undefined;
    const labels = [
      ...(ticket.priority ? [ticket.priority] : []),
      ...(tierLabel ? [tierLabel] : []),
      ...(autoReady ? [FLEET_LABELS.ready] : []),
    ];
    const { valid, dropped } = resolveDependsOnIndex(index, ticket.dependsOnIndex, result.tickets.length);
    if (dropped.length > 0) {
      log("loop", `${key(project.name, issue.number)}: dropping invalid dependsOnIndex ${dropped.join(", ")} on child "${ticket.title}"`);
      droppedNotes.push(`- "${ticket.title}": dropped invalid dependsOnIndex ${dropped.join(", ")}`);
    }
    // `resolveDependsOnIndex` only ever returns indices strictly earlier than
    // `index`, so each has already been filed and has a real issue number.
    const dependsOn = valid.map((i) => created[i]!.number);
    const body = bodyWithDependsOn(bodyWithPartOf(ticket.body, issue.number), dependsOn);
    const child = await createIssue(project, { title: ticket.title, body, labels });
    created.push({ ...child, title: ticket.title });
  }
  if (created.length > 0) {
    // Stamp onto the body GitHub holds *right now*, never the claim-time (or,
    // for a resumed session, synthesized-empty) snapshot: `updateIssueBody`
    // overwrites the whole body, so stamping a stale one destroys the epic's
    // description and any edits a human made while the planner ran. No fresh
    // read → no stamp; the child list above is in the status comment anyway.
    try {
      const live = await getIssue(project, issue.number);
      if (live) {
        await updateIssueBody(project, issue.number, bodyWithChildTaskList(live.body, created));
      } else {
        log("loop", `${key(project.name, issue.number)}: could not re-read the epic body — skipping the Children stamp`);
      }
    } catch (err) {
      logError("loop", `${key(project.name, issue.number)}: could not stamp the Children task list onto the epic body`, err);
    }
  }
  const record = ctx.state.get(project.name, issue.number);
  await moveToReview(ctx, project, issue.number, {
    comment: [
      `**Status: planned** (confidence: ${result.confidence})`,
      result.summary,
      machineReviewLine(record?.machineReviewOutcome),
      created.length > 0
        ? `Child tickets:\n${created.map((c) => `- #${c.number} ${c.title} — ${c.url}`).join("\n")}`
        : "No child tickets were proposed.",
      droppedNotes.length > 0 ? `Dropped invalid dependencies:\n${droppedNotes.join("\n")}` : "",
      autoReady ? "" : "Label a child `fleet:ready` to start it.",
    ].filter(Boolean).join("\n\n"),
    update: { lastSummary: result.summary },
    logLine: `planned ${created.length} child ticket(s)`,
  });
}

/**
 * Whether this epic already has filed children, per GitHub: the live body's
 * `## Children` list (present once the stamp succeeded) or any issue carrying
 * the epic's `Part-of:` stamp (present from the first `createIssue`, so it
 * also catches a crash before the stamp). Fails open to "none found" — a
 * transient search failure must not block a first filing.
 */
async function hasExistingChildren(project: ProjectConfig, issue: ReadyIssue): Promise<boolean> {
  try {
    const live = await getIssue(project, issue.number);
    if (parseChildTaskList(live?.body ?? issue.body).length > 0) return true;
    return (await findChildIssues(project, issue.number)).length > 0;
  } catch (err) {
    logError("loop", `${key(project.name, issue.number)}: could not check for existing children — proceeding to file`, err);
    return false;
  }
}

export async function finishBlocked(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: ReadyIssue,
  reason: string,
  summary?: string,
): Promise<void> {
  const blockedScope = key(project.name, issue.number);
  try {
    await upsertStatusComment(
      project,
      issue.number,
      [`**Status: needs input**`, summary ?? "", `Blocked on: ${reason}`, "Reply from the fleet dashboard to continue."].filter(Boolean).join("\n\n"),
    );
  } catch (err) {
    logError("loop", `${blockedScope}: could not post the needs-input status comment`, err);
  }
  await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput);
  ctx.state.update(project.name, issue.number, { status: "needs-input", lastSummary: reason });
  ctx.emitBoard();
  log("loop", `${blockedScope}: needs input — ${reason}`);
  await notify(ctx, "needs-input", project, { issueNumber: issue.number, title: issue.title, detail: reason, url: issueUrl(project, issue.number) });
}

/**
 * An operator restart aborts the session, which reaches `supervise` (or the
 * claim/resume failure paths) as an ordinary errored turn. Reporting that would
 * post a "failed" comment and swap the issue to `fleet:needs-input`, fighting the
 * reset `restartTicket` is about to do — so a restarting key is logged and
 * dropped instead. Guarding here rather than at the call sites means no failure
 * path can leak past it.
 *
 * A daemon stop-now aborts sessions the same way, but for a different reason:
 * the ticket isn't being reset, it's being interrupted so the *next* boot can
 * resume it for free. That ends in `stalled` with `sessionId` left untouched
 * (`runSession`'s `finally` already wrote it back) and `autoResumed` cleared,
 * rather than `needs-input` — no status comment or label churn either, same
 * as the restart guard above.
 */
export async function finishFailed(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: ReadyIssue,
  error: string,
  opts: { postCompletion?: boolean } = {},
): Promise<void> {
  const scope = key(project.name, issue.number);
  if (ctx.restarting.has(scope)) {
    log("loop", `${scope}: run ended during an operator restart (${error}) — not reporting it as a failure`);
    return;
  }
  if (ctx.stopping.has(scope)) {
    ctx.state.update(project.name, issue.number, { status: "stalled", autoResumed: false });
    ctx.emitBoard();
    log("loop", `${scope}: run ended during a daemon stop-now (${error}) — left stalled with its session for auto-resume on next boot`);
    return;
  }

  // The worker itself already succeeded — commits exist — so re-running the
  // ticket on a stronger model can't fix a git/GitHub API problem. Never
  // elevate here, and never touch `autoElevated` so a real model failure
  // later still gets its one shot.
  if (opts.postCompletion) {
    const record = ctx.state.get(project.name, issue.number);
    const postMortem = await gatherFailurePostMortem(ctx.dataDirPath, project, issue, record, {
      leadLine: "The worker completed successfully, but a step after completion failed:",
      error,
      retryHint: "Resolve manually (the branch and its commits are intact) and reply from the dashboard, or re-label `fleet:ready` to retry.",
    });
    try {
      await upsertStatusComment(project, issue.number, [`**Status: needs input**`, postMortem].join("\n\n"));
    } catch (err) {
      logError("loop", `${scope}: could not post the needs-input status comment`, err);
    }
    await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput);
    ctx.state.update(project.name, issue.number, { status: "failed", lastSummary: error });
    ctx.emitBoard();
    log("loop", `${scope}: post-completion step failed (not auto-elevating) — needs input: ${error}`);
    await notify(ctx, "needs-input", project, { issueNumber: issue.number, title: issue.title, detail: error, url: issueUrl(project, issue.number) });
    return;
  }

  const record = ctx.state.get(project.name, issue.number);
  if (shouldAutoElevate(project, record)) {
    try {
      await upsertStatusComment(
        project,
        issue.number,
        [
          `**Status: failed**`,
          `The worker run failed: ${error}`,
          `Retrying automatically on the elevated model (\`${project.elevatedModel}\`).`,
        ].join("\n\n"),
      );
    } catch (err) {
      logError("loop", `${scope}: could not post the failed status comment`, err);
    }
    await escalateToElevated(project, issue.number);
    ctx.state.update(project.name, issue.number, { status: "failed", lastSummary: error, autoElevated: true });
    ctx.emitBoard();
    log("loop", `${scope}: failed — auto-escalating to ${project.elevatedModel} (once)`);
    new Journal(ctx.dataDirPath, project.name, issue.number).append({
      type: "fleet",
      event: "auto-elevated",
      fromModel: record?.model,
      toModel: project.elevatedModel,
      error,
    });
    return;
  }

  const postMortem = await gatherFailurePostMortem(ctx.dataDirPath, project, issue, record, {
    leadLine: "The worker run failed:",
    error,
    retryHint: "Re-label with `fleet:ready` to retry, or reply from the dashboard to resume.",
  });
  try {
    await upsertStatusComment(project, issue.number, [`**Status: failed**`, postMortem].join("\n\n"));
  } catch (err) {
    logError("loop", `${scope}: could not post the failed status comment`, err);
  }
  await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput);
  ctx.state.update(project.name, issue.number, { status: "failed", lastSummary: error });
  ctx.emitBoard();
  await notify(ctx, "failed", project, { issueNumber: issue.number, title: issue.title, detail: error, url: issueUrl(project, issue.number) });
}

/**
 * The failure tail the claim and resume paths share: log what blew up, then try
 * to report it to GitHub — a reporting failure on top is logged and swallowed,
 * since there is nowhere left to escalate it to.
 */
export async function reportRunFailure(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: ReadyIssue,
  what: string,
  err: unknown,
): Promise<void> {
  const scope = key(project.name, issue.number);
  logError("loop", `${scope} ${what}`, err);
  try {
    await finishFailed(ctx, project, issue, err instanceof Error ? err.message : String(err), {
      postCompletion: err instanceof PostCompletionError,
    });
  } catch (reportErr) {
    logError("loop", `${scope}: could not report failure to GitHub`, reportErr);
  }
}
