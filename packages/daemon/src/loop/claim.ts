import {
  ELEVATE_LABEL,
  FLEET_LABELS,
  LIGHT_LABEL,
  PLAN_LABEL,
  type BoardTicket,
  type ProjectConfig,
  type TicketRecord,
} from "@fleet/shared";
import { cleanupFinished } from "./board.ts";
import { computeBudgetGate } from "./budget.ts";
import { countRunning, key, track, type LoopContext } from "./context.ts";
import { reportRunFailure } from "./finish.ts";
import { releaseStaleClaims } from "./heartbeat.ts";
import { isProjectPaused } from "./pause.ts";
import { computeWorkHoursReserveGate } from "./workHoursReserve.ts";
import {
  addAssignee,
  dependencyStatus,
  getAuthenticatedLogin,
  getIssueAssignees,
  getIssueComments,
  getPushCollaborators,
  listFleetIssues,
  listIssueStates,
  parseDependsOn,
  removeAssignee,
  swapLabel,
  toBoardTicket,
  type ReadyIssue,
} from "../github/github.ts";
import { Journal } from "../store/journal.ts";
import { log, logError } from "../log.ts";
import { notify, projectUrl } from "../notify.ts";
import { addressComments } from "./comments.ts";
import { autoMergeReady } from "./automerge.ts";
import { addressReviews } from "./reviews.ts";
import { runSession } from "./runner.ts";
import { buildIssuePrompt } from "../session/worker.ts";
import { createWorktree } from "../github/worktree.ts";

/** Fleet status labels that mean an issue has already moved past `fleet:ready`. */
const POST_READY_STATUS_LABELS = [FLEET_LABELS.inProgress, FLEET_LABELS.needsInput, FLEET_LABELS.review];

/** `TicketRecord` statuses that mean the daemon already knows this ticket is past ready, even if labels look clean. */
const POST_READY_RECORD_STATUSES = new Set<TicketRecord["status"]>(["review", "needs-input"]);

/**
 * The `fleet:ready` issues that are actually claimable this cycle: not already
 * in flight, not carrying a stale `fleet:ready` alongside a status label that
 * says otherwise, not already past ready per the daemon's own state record,
 * routed to this daemon (unassigned, or assigned to `myLogin` — never an
 * issue assigned to someone else, whether that's a competing daemon or a
 * human), and with every `Depends-on` reference satisfied (closed, or
 * pointing at an issue number this repo has never had). Preserves the input
 * order, which callers sort by priority-then-number before this filter runs.
 */
export function selectEligibleReady(
  issues: ReadyIssue[],
  opts: {
    openIssueNumbers: ReadonlySet<number>;
    allIssueNumbers: ReadonlySet<number>;
    isRunning: (issueNumber: number) => boolean;
    getRecord: (issueNumber: number) => TicketRecord | undefined;
    projectName: string;
    myLogin: string;
  },
): ReadyIssue[] {
  return issues.filter((issue) => {
    if (!issue.labels.includes(FLEET_LABELS.ready)) return false;
    if (opts.isRunning(issue.number)) return false;

    const others = (issue.assignees ?? []).filter((login) => login !== opts.myLogin);
    if (others.length > 0) {
      log(
        "loop",
        `${key(opts.projectName, issue.number)}: assigned to ${others.join(", ")}, not this daemon — skipping claim`,
      );
      return false;
    }

    const conflicting = POST_READY_STATUS_LABELS.filter((label) => issue.labels.includes(label));
    if (conflicting.length > 0) {
      log(
        "loop",
        `${key(opts.projectName, issue.number)}: fleet:ready alongside ${conflicting.join(", ")} — inconsistent labels, skipping claim`,
      );
      return false;
    }

    const record = opts.getRecord(issue.number);
    if (record && (POST_READY_RECORD_STATUSES.has(record.status) || record.prUrl)) {
      log(
        "loop",
        `${key(opts.projectName, issue.number)}: record already past ready (status=${record.status}${
          record.prUrl ? `, prUrl=${record.prUrl}` : ""
        }) — skipping claim`,
      );
      return false;
    }

    const { blockedBy } = dependencyStatus(parseDependsOn(issue.body), opts.openIssueNumbers, opts.allIssueNumbers);
    return blockedBy.length === 0;
  });
}

/**
 * The contributor floor: `issues` whose author has push access to the repo,
 * per `collaborators`. Anyone can open an issue, and `fleet:ready` on it is
 * all it takes to get a worker with Bash access on the operator's machine
 * running against it — this is the last line of defense against that. A
 * skipped issue is logged once (via `alreadyLogged`, `LoopContext`-owned so
 * it survives across cycles) rather than every cycle it sits in `fleet:ready`
 * un-actioned.
 */
export function selectCollaboratorAuthored(
  issues: ReadyIssue[],
  collaborators: ReadonlySet<string>,
  opts: { projectName: string; alreadyLogged: Set<string> },
): ReadyIssue[] {
  return issues.filter((issue) => {
    if (collaborators.has(issue.author)) return true;
    const scope = key(opts.projectName, issue.number);
    if (!opts.alreadyLogged.has(scope)) {
      opts.alreadyLogged.add(scope);
      log("loop", `${scope}: author @${issue.author} is not a repo collaborator with push access — skipping claim`);
    }
    return false;
  });
}

/**
 * Fetches the repo's push collaborators (via `getPushCollaborators`'s
 * per-repo, daemon-lifetime cache — already paid for by mid-flight comment
 * ingestion in `comments.ts`, so an already-checked repo costs no extra `gh`
 * call here) and applies the contributor floor. A lookup failure fails
 * closed: every ready issue is held for this cycle rather than claimed on an
 * unverified author, and the next cycle retries.
 */
export async function applyContributorFloor(
  ctx: LoopContext,
  project: ProjectConfig,
  issues: ReadyIssue[],
): Promise<ReadyIssue[]> {
  if (issues.length === 0) return issues;
  let collaborators: Set<string>;
  try {
    collaborators = await getPushCollaborators(project);
  } catch (err) {
    logError("loop", `${project.name}: could not verify issue authors against repo collaborators — holding all claims this cycle`, err);
    return [];
  }
  return selectCollaboratorAuthored(issues, collaborators, {
    projectName: project.name,
    alreadyLogged: ctx.contributorFloorSkipsLogged,
  });
}

/**
 * Nice-to-have self-heal: when the daemon's own record shows a ticket already
 * pushed to review (has a PR) but the issue still carries `fleet:ready` — the
 * exact "clean labels, stale record" case `selectEligibleReady`'s record guard
 * defends against — drop the stale label so the conflict doesn't get
 * re-logged every cycle. Never touches issues where the labels themselves are
 * the inconsistency (that's surfaced via the log line above instead, since
 * swapping labels on a human/tooling-caused conflict could paper over
 * whatever caused it).
 */
export async function healStaleReadyLabels(ctx: LoopContext, project: ProjectConfig, issues: ReadyIssue[]): Promise<void> {
  for (const issue of issues) {
    if (!issue.labels.includes(FLEET_LABELS.ready)) continue;
    if (POST_READY_STATUS_LABELS.some((label) => issue.labels.includes(label))) continue;
    const record = ctx.state.get(project.name, issue.number);
    if (record?.status !== "review" || !record.prUrl) continue;
    log(
      "loop",
      `${key(project.name, issue.number)}: removing stale fleet:ready label (already in review, PR ${record.prUrl})`,
    );
    await swapLabel(project, issue.number, FLEET_LABELS.ready, FLEET_LABELS.review);
  }
}

/**
 * One project's slice of a poll cycle: refresh its board projection, clean up
 * finished tickets, let in-flight work claim capacity first (PR review
 * feedback), then claim `fleet:ready` issues with whatever capacity is left
 * — capped by both `maxConcurrent` (running sessions) and `maxInReview`
 * (issues already labeled `fleet:review`, so the review queue can't grow
 * faster than a human can clear it). Board polling, cleanup, and issue-comment
 * injection all run regardless of pause state, daemon-wide or per-project —
 * pause means no *new* work, and steering a comment into an already-live
 * session isn't new work (`addressComments` gates only its own cold-resume
 * path on pause, same as it already does for a live shutdown). Review
 * feedback resumption and new claims are new work, so they're held while
 * either pause applies; auto-merge sits between them — it starts no session,
 * but shares their pause gate anyway since there's no case for merging PRs
 * out from under an operator-requested pause.
 */
export async function cycleProject(ctx: LoopContext, project: ProjectConfig): Promise<void> {
  const issues = await listFleetIssues(project);
  const { open: openIssueNumbers, all: allIssueNumbers } = await listIssueStates(project);
  const myLogin = await getAuthenticatedLogin();

  const blockedByIssue = new Map<number, number[]>();
  for (const issue of issues) {
    const { blockedBy, unknown } = dependencyStatus(parseDependsOn(issue.body), openIssueNumbers, allIssueNumbers);
    for (const n of unknown) {
      log("loop", `${key(project.name, issue.number)}: Depends-on references #${n}, which doesn't exist in this repo — treating as satisfied`);
    }
    blockedByIssue.set(issue.number, blockedBy);
  }

  ctx.boardCache.set(
    project.name,
    issues
      .map((issue) => toBoardTicket(project, issue, blockedByIssue.get(issue.number)))
      .filter((t): t is BoardTicket => t !== null),
  );
  ctx.emitBoard();

  if (ctx.dryRun) {
    log("loop", `[dry-run] would clean up finished tickets for ${project.name}`);
  } else {
    await cleanupFinished(ctx, project, issues);
  }

  if (ctx.dryRun) {
    log("loop", `[dry-run] would heal stale fleet:ready labels for ${project.name}`);
  } else {
    await healStaleReadyLabels(ctx, project, issues);
  }

  if (ctx.dryRun) {
    log("loop", `[dry-run] would check ${project.name} for stale claims to release`);
  } else {
    await releaseStaleClaims(ctx, project, issues, myLogin);
  }

  if (ctx.dryRun) {
    log("loop", `[dry-run] would check ${project.name} for new issue comments to inject`);
  } else {
    await addressComments(ctx, project, openIssueNumbers);
  }

  if (isProjectPaused(ctx, project.name)) return;

  if (ctx.dryRun) {
    log("loop", `[dry-run] would check ${project.name} for PR review feedback to address`);
  } else {
    await addressReviews(ctx, project, openIssueNumbers);
  }

  if (ctx.dryRun) {
    log("loop", `[dry-run] would check ${project.name} for approved, green PRs to auto-merge`);
  } else {
    await autoMergeReady(ctx, project, openIssueNumbers);
  }

  const inReview = issues.filter((issue) => issue.labels.includes(FLEET_LABELS.review)).length;
  if (inReview >= project.maxInReview) {
    log("loop", `${project.name}: ${inReview} in review >= maxInReview ${project.maxInReview} — holding claims`);
    return;
  }

  const capacity = Math.min(
    project.maxConcurrent - countRunning(ctx.running.keys(), project.name),
    project.maxInReview - inReview,
  );
  if (capacity <= 0) return;

  const reserve = computeWorkHoursReserveGate(ctx);
  if (reserve.active) {
    log(
      "loop",
      `${project.name}: work-hours reserve active — holding claims until ${reserve.releaseAt?.toLocaleTimeString()}`,
    );
    return;
  }

  let ready = selectEligibleReady(issues, {
    openIssueNumbers,
    allIssueNumbers,
    isRunning: (issueNumber) => ctx.running.has(key(project.name, issueNumber)),
    getRecord: (issueNumber) => ctx.state.get(project.name, issueNumber),
    projectName: project.name,
    myLogin,
  });
  ready = await applyContributorFloor(ctx, project, ready);

  const gate = computeBudgetGate(ctx);
  if (gate.level === "blocked") {
    const holdLine = `window spend $${gate.spentUsd.toFixed(2)} >= budget $${(gate.budgetUsd ?? 0).toFixed(2)} — holding all claims`;
    log("loop", `${project.name}: ${holdLine}`);
    // Only the first hold of a spell notifies — this gate is recomputed (and would re-fire) every
    // poll cycle for as long as spend stays over budget, unlike extendPause's own once-per-hit dedup.
    if (!ctx.budgetBlockedNotified.has(project.name)) {
      ctx.budgetBlockedNotified.add(project.name);
      await notify(ctx, "paused", project, { title: "Budget gate", detail: holdLine, url: projectUrl(project) });
    }
    return;
  }
  ctx.budgetBlockedNotified.delete(project.name);
  if (gate.level === "light-only") {
    log(
      "loop",
      `${project.name}: window spend $${gate.spentUsd.toFixed(2)} past the light threshold of budget $${(gate.budgetUsd ?? 0).toFixed(2)} — claiming ${LIGHT_LABEL} only`,
    );
    ready = ready.filter((issue) => issue.labels.includes(LIGHT_LABEL));
  }

  for (const issue of ready.slice(0, Math.max(0, capacity))) {
    if (ctx.dryRun) {
      log("loop", `[dry-run] would claim ${project.name}#${issue.number}: ${issue.title}`);
      continue;
    }
    // `paused` above is a snapshot taken before this cycle's several awaited
    // GitHub calls; a shutdown requested mid-cycle needs a fresh check, taken
    // with nothing awaited between it and `track()`, so it can't start a
    // session `stopLiveSessions` has already swept past.
    if (ctx.isShuttingDown()) return;
    track(ctx, project.name, issue.number, processTicket(ctx, project, issue));
  }
}

/**
 * How long to wait between self-assigning and reading the assignee list back
 * — closest available thing to compare-and-swap, since label/assignee writes
 * on the GitHub REST API aren't atomic. Long enough for a second daemon's
 * concurrent write (started around the same moment) to have landed by the
 * time this reads it back; not a retry loop, just one settle-then-check.
 */
const CLAIM_VERIFY_DELAY_MS = 2_500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ClaimVerdict = "won" | "lost";

/**
 * Given this daemon's own login and the issue's assignees right after both
 * competing daemons have raced to self-assign, decides who keeps the claim:
 * lexicographically lowest login wins. Pure so the tiebreak is unit-testable
 * without mocking `gh`. `selectEligibleReady`'s routing rule already excludes
 * issues pre-assigned to anyone else, so any assignee besides `myLogin` seen
 * here is a same-cycle competing claim, not a stale human assignment.
 */
export function resolveClaimCollision(myLogin: string, assignees: string[]): ClaimVerdict {
  const distinct = [...new Set(assignees)];
  if (distinct.length <= 1) return "won";
  return [...distinct].sort()[0] === myLogin ? "won" : "lost";
}

/** Claims a ready issue: label swap, self-assign CAS, fresh worktree + branch, state record, then a session. */
export async function processTicket(ctx: LoopContext, project: ProjectConfig, issue: ReadyIssue): Promise<void> {
  const now = new Date().toISOString();
  const scope = key(project.name, issue.number);
  log("loop", `claiming ${scope}: ${issue.title}`);

  try {
    await swapLabel(project, issue.number, FLEET_LABELS.ready, FLEET_LABELS.inProgress);

    const myLogin = await getAuthenticatedLogin();
    await addAssignee(project, issue.number, myLogin);
    await delay(CLAIM_VERIFY_DELAY_MS);
    const assignees = await getIssueAssignees(project, issue.number);
    if (resolveClaimCollision(myLogin, assignees) === "lost") {
      const winner = assignees.filter((login) => login !== myLogin).sort()[0];
      log("loop", `${scope}: lost the claim race to ${winner} — abandoning (label stays fleet:in-progress, owned by the winner)`);
      await removeAssignee(project, issue.number, myLogin);
      return;
    }

    const comments = await getIssueComments(project, issue.number);
    const worktree = await createWorktree(project, issue.number, ctx.config.worktreeRoot, issue.labels);

    const elevated = issue.labels.includes(ELEVATE_LABEL);
    const light = issue.labels.includes(LIGHT_LABEL);
    const isPlan = issue.labels.includes(PLAN_LABEL);
    // A fresh claim otherwise wipes the once-only escalation guard along with
    // everything else the prior attempt recorded — carry it forward so a
    // second failure (now elevated) can't trigger a second auto-escalation.
    const autoElevated = ctx.state.get(project.name, issue.number)?.autoElevated ?? false;
    ctx.state.upsert({
      project: project.name,
      issueNumber: issue.number,
      issueTitle: issue.title,
      branch: worktree.branch,
      worktreePath: worktree.path,
      status: "running",
      startedAt: now,
      lastActivityAt: now,
      costUsd: 0,
      elevated,
      light,
      isPlan,
      autoElevated,
      // Every comment that exists at claim time is already in `comments`, folded
      // into the first prompt below — the watermark stops the next cycle's
      // `addressComments` from re-injecting them.
      lastCommentHandledAt: now,
    });

    const journal = new Journal(ctx.dataDirPath, project.name, issue.number);
    journal.append({ type: "fleet", event: "claimed", issue: issue.number, title: issue.title, elevated, light, isPlan });

    await runSession(ctx, {
      project,
      issue,
      worktree,
      journal,
      firstMessage: buildIssuePrompt(project, issue, comments),
      elevated,
      light,
      kind: isPlan ? "plan" : "code",
    });
  } catch (err) {
    await reportRunFailure(ctx, project, issue, "failed", err);
  }
}
