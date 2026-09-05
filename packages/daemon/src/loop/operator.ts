import { FLEET_LABELS, type ProjectConfig } from "@fleet/shared";
import { key, track, type LoopContext } from "./context.ts";
import {
  clearAssignees,
  closeIssue,
  closePullRequest,
  getIssue,
  getIssueLabels,
  markReady,
  parseChildTaskList,
  upsertStatusComment,
} from "../github/github.ts";
import { deleteRemoteBranch } from "../github/worktree.ts";
import { Journal } from "../store/journal.ts";
import { log, logError } from "../log.ts";
import { resumeTicket } from "./runner.ts";
import { teardownTicket } from "./teardown.ts";

/** How long a restart waits for an aborted run to unwind before resetting anyway. */
const ABORT_DRAIN_MS = 30_000;

const RESTART_SUMMARY =
  "Restarted from the dashboard — a fresh session will pick this up. The previous session was terminated and its branch and worktree will be recreated from scratch.";

/** Resolves when `promise` settles or `ms` elapses — whichever is first, never rejecting. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    void promise.then(done, done);
  });
}

/**
 * Whether `reply`/`restartTicket` would actually accept this ticket right now,
 * mirroring their guard clauses (and the `/restart` route's known-ticket
 * check) exactly — the single source of truth the dashboard gates its buttons
 * on, so the two policies can't drift apart.
 *
 * Deliberately looks up `ctx.state.get` itself rather than accepting a record
 * from the caller: the ticket-detail route falls back to the archived history
 * record for closed tickets, but `reply()` never consults history — it always
 * re-reads live state — so a closed ticket's leftover `sessionId` must not
 * leak into `canReply`.
 */
export function ticketCapabilities(
  ctx: LoopContext,
  projectName: string,
  issueNumber: number,
  known: boolean,
): { canRestart: boolean; canReply: boolean } {
  const scope = key(projectName, issueNumber);
  const hasLiveSession = ctx.live.has(scope);
  const inFlight = ctx.running.has(scope);
  const liveRecord = ctx.state.get(projectName, issueNumber);
  return {
    canRestart: known && !ctx.restarting.has(scope) && (hasLiveSession || !inFlight),
    canReply: ctx.replyWaiters.has(scope) || hasLiveSession || (Boolean(liveRecord?.sessionId) && !inFlight),
  };
}

/**
 * Routes a dashboard reply to its ticket: a session parked awaiting input, a
 * session already running, or a cold ticket that needs resuming from its
 * recorded session id.
 */
export async function reply(
  ctx: LoopContext,
  projectName: string,
  issueNumber: number,
  message: string,
  reason: string = "operator-reply",
): Promise<"steered" | "resumed"> {
  const scope = key(projectName, issueNumber);
  // A human-driven session earns a fresh auto-recovery if it stalls — but only
  // once the reply actually lands, so each success path below clears the flag
  // itself. Clearing up front would let a *rejected* reply (409 on
  // mid-transition, say) refund the once-only auto-resume budget.

  const waiter = ctx.replyWaiters.get(scope);
  if (waiter) {
    ctx.state.update(projectName, issueNumber, { autoResumed: false });
    waiter(message);
    new Journal(ctx.dataDirPath, projectName, issueNumber).append({ type: "fleet", event: "operator-message-injected", mode: "parked", reason });
    return "steered";
  }

  const liveSession = ctx.live.get(scope);
  if (liveSession) {
    ctx.state.update(projectName, issueNumber, { autoResumed: false });
    liveSession.send(message);
    log("loop", `${scope}: reply queued into running session`);
    new Journal(ctx.dataDirPath, projectName, issueNumber).append({ type: "fleet", event: "operator-message-injected", mode: "live", reason });
    return "steered";
  }

  const record = ctx.state.get(projectName, issueNumber);
  const project = ctx.getProject(projectName);
  if (!project) throw new Error(`unknown project ${projectName}`);
  if (!record?.sessionId) throw new Error(`no session recorded for ${scope}; label the issue fleet:ready to start fresh`);
  if (ctx.running.has(scope)) throw new Error(`${scope} is mid-transition; try again shortly`);
  if (ctx.isShuttingDown()) throw new Error(`daemon is shutting down; reply again once it's back up`);

  ctx.state.update(projectName, issueNumber, { autoResumed: false });
  track(ctx, projectName, issueNumber, resumeTicket(ctx, project, record, message, reason));
  return "resumed";
}

/**
 * Force-close a ticket's session and put the issue back in `fleet:ready` so the
 * next poll cycle claims it from scratch. `processTicket` → `createWorktree`
 * force-removes the worktree and recreates the branch from
 * `origin/<defaultBranch>`, so a restart **discards the previous session's
 * commits** — that is the point, and the dashboard says so before firing.
 *
 * The claim is deliberately left to the normal loop rather than done here, so
 * restarts obey `maxConcurrent` like any other pickup.
 */
export async function restartTicket(ctx: LoopContext, projectName: string, issueNumber: number): Promise<void> {
  const scope = key(projectName, issueNumber);
  const project = ctx.getProject(projectName);
  if (!project) throw new Error(`unknown project ${projectName}`);
  if (ctx.restarting.has(scope)) throw new Error(`${scope} is already restarting`);

  const session = ctx.live.get(scope);
  const inFlight = ctx.running.get(scope);
  // In flight with no session to abort means the ticket is between phases
  // (claiming, opening a PR, tearing a session down) where interrupting would
  // leave GitHub and the worktree disagreeing. Same guard as `reply`.
  if (!session && inFlight) throw new Error(`${scope} is mid-transition; try again shortly`);

  // Captured before the live-session branch below overwrites `lastSummary`
  // with restart boilerplate, so the real prior summary/failure reason still
  // reaches `resetForFreshClaim` — the common case for restarting a stuck
  // running/needs-input ticket has a live session, and would otherwise
  // clobber it before `resetForFreshClaim` ever gets to read it.
  const priorSummary = ctx.state.get(projectName, issueNumber)?.lastSummary;

  if (session) {
    // The flag must be set before the abort: aborting surfaces to `supervise`
    // as an errored turn, and `finishFailed` has to know not to report it.
    ctx.restarting.add(scope);
    ctx.state.update(projectName, issueNumber, { status: "restarting", lastSummary: RESTART_SUMMARY });
    ctx.emitBoard();
    log("loop", `${scope}: restart requested — aborting session ${session.sessionId ?? "(not yet started)"}`);
    session.abortController.abort();
    // A session parked after reporting `blocked` is waiting on a reply, not on
    // the SDK, so it would ignore the abort for the rest of `replyWaitMinutes`.
    // Release the park so `supervise` returns now.
    ctx.replyWaiters.get(scope)?.(undefined);
    // The flag is cleared when the run actually settles, however long that
    // takes — a wedged session that errors out much later must still not report
    // a failure over the reset. The reset itself waits only `ABORT_DRAIN_MS` so
    // the dashboard always gets an answer; `running` still holds the key
    // meanwhile, so no fresh claim can start until the old run is truly gone.
    const clear = () => void ctx.restarting.delete(scope);
    const drained = (inFlight ?? Promise.resolve()).then(clear, clear);
    // Wait for the run to unwind so its teardown (state writes, session close)
    // lands before the reset below overwrites the record.
    await settleWithin(drained, ABORT_DRAIN_MS);
    if (ctx.restarting.has(scope)) {
      log("loop", `${scope}: session did not unwind within ${ABORT_DRAIN_MS / 1000}s — resetting to ready anyway`);
    }
  }

  await resetForFreshClaim(ctx, project, issueNumber, priorSummary);
}

/**
 * Closes a reviewed plan epic's issue — the completion signal `cleanupFinished`
 * (`board.ts`) needs to retire a PR-less plan record on the next poll cycle.
 * Validation (must be a plan, must be in review) is the route's job, since it
 * maps each failure to its own status code; this only guards the race the
 * route can't see — the ticket moving mid-request.
 */
/**
 * Accepting a plan means the *planning* is done: every still-open child in the
 * epic's `## Children` task list is released from `fleet:backlog` to
 * `fleet:ready`, and the epic issue itself is closed. The epic doesn't track
 * its children's delivery — that's what the children's own PRs are for — so
 * nothing waits on them. A child already carrying another fleet state label
 * (someone released or started it by hand) is left alone, since `markReady`
 * would otherwise yank an in-progress child back to ready. Children with an
 * unsatisfied `Depends-on` sit in Ready until the claim loop's dependency gate
 * lets them through. A child that fails to relabel is logged and named in the
 * status comment rather than aborting the accept, so one flaky `gh` call can't
 * leave the epic half-accepted.
 */
export async function acceptPlan(
  ctx: LoopContext,
  projectName: string,
  issueNumber: number,
): Promise<{ released: number[]; failed: number[] }> {
  const scope = key(projectName, issueNumber);
  const project = ctx.getProject(projectName);
  if (!project) throw new Error(`unknown project ${projectName}`);
  if (ctx.running.has(scope)) throw new Error(`${scope} is mid-transition; try again shortly`);

  const live = await getIssue(project, issueNumber);
  const children = live ? parseChildTaskList(live.body).filter((c) => !c.checked) : [];
  const released: number[] = [];
  const failed: number[] = [];
  for (const child of children) {
    try {
      const labels = await getIssueLabels(project, child.number);
      if (STATE_LABELS_OTHER_THAN_BACKLOG.some((l) => labels.includes(l))) {
        log("loop", `${scope}: child #${child.number} already carries a fleet state label — not relabeling`);
        continue;
      }
      await markReady(project, child.number);
      released.push(child.number);
    } catch (err) {
      failed.push(child.number);
      logError("loop", `${scope}: could not release child #${child.number} to fleet:ready`, err);
    }
  }

  const record = ctx.state.get(projectName, issueNumber);
  const comment = [
    record?.lastSummary,
    "**Plan accepted by operator.**",
    released.length > 0 ? `Released to \`fleet:ready\`: ${released.map((n) => `#${n}`).join(", ")}` : "",
    failed.length > 0 ? `Could not relabel (mark \`fleet:ready\` by hand): ${failed.map((n) => `#${n}`).join(", ")}` : "",
  ].filter(Boolean).join("\n\n");
  try {
    await upsertStatusComment(project, issueNumber, comment);
  } catch (err) {
    logError("loop", `${scope}: could not post the plan-accepted status comment`, err);
  }
  await closeIssue(project, issueNumber);
  ctx.emitBoard();
  log("loop", `${scope}: plan accepted by operator — released ${released.length} child(ren), issue closed`);
  return { released, failed };
}

const STATE_LABELS_OTHER_THAN_BACKLOG = [FLEET_LABELS.ready, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput, FLEET_LABELS.review];

/**
 * Drop everything that would make the next cycle resume rather than restart:
 * the recorded session id, the live flag, and the once-only auto-resume budget.
 * The journal file is kept — only an entry is appended — so the restarted
 * ticket's history stays readable in the dashboard.
 *
 * `priorSummary` is the real prior summary/failure reason to preserve into
 * `priorAttemptSummary` so the next claim's prompt can still surface it
 * (`buildPriorAttemptBlock`) once `lastSummary` below is overwritten with
 * restart boilerplate. `restartTicket` captures it itself, before its
 * live-session branch does that overwrite early; a caller that doesn't pass
 * one (e.g. a direct call with no live session in play) falls back to
 * whatever `lastSummary` still holds right now.
 */
export async function resetForFreshClaim(
  ctx: LoopContext,
  project: ProjectConfig,
  issueNumber: number,
  priorSummary?: string,
): Promise<void> {
  const scope = key(project.name, issueNumber);
  const prior = ctx.state.get(project.name, issueNumber);
  const preservedSummary = priorSummary ?? prior?.lastSummary;
  new Journal(ctx.dataDirPath, project.name, issueNumber).append({
    type: "fleet",
    event: "restarted-by-operator",
  });
  // A restart discards the previous attempt, so its PR and remote branch go
  // too: leaving them makes the fresh run's push non-fast-forward and its
  // `gh pr create` collide with a zombie PR reviewers can still act on.
  // Best-effort — `finishCompleted`'s adopt-existing fallback covers a miss.
  if (prior?.prUrl) {
    try {
      await closePullRequest(project, prior.prUrl, "Superseded — this ticket was restarted from the fleet dashboard; a fresh session will open a new PR.");
    } catch (err) {
      logError("loop", `${scope}: could not close the superseded PR ${prior.prUrl}`, err);
    }
  }
  if (prior?.branch) await deleteRemoteBranch(project, prior.branch);
  // The restart discards the previous attempt's worktree wholesale, so its
  // per-worktree resources go with it (no-op unless teardownPending is set);
  // the fresh claim's setup re-provisions from scratch.
  if (prior) await teardownTicket(ctx, project, prior);
  ctx.state.update(project.name, issueNumber, {
    status: "restarting",
    sessionId: undefined,
    sessionLive: false,
    autoResumed: false,
    machineReviewOutcome: undefined,
    // A restarted ticket's worktree is torn down and rebuilt from scratch, so
    // any PR the previous session opened no longer reflects what's about to
    // run — and a lingering `prUrl` would make the claim guard in `claim.ts`
    // treat this ticket as permanently past ready.
    prUrl: undefined,
    lastSummary: RESTART_SUMMARY,
    priorAttemptSummary: preservedSummary,
    lastActivityAt: new Date().toISOString(),
    lastActivityNote: undefined,
  });
  // Unassign before the label goes back to ready, so the routing rule in
  // `selectEligibleReady` never sees a "ready" issue still assigned to
  // whoever last claimed it — otherwise it would look permanently routed to
  // that daemon instead of back in the shared pool.
  await clearAssignees(project, issueNumber);
  // Label last: from here the ticket is claimable, so nothing after this may
  // write to the state record.
  await markReady(project, issueNumber);
  ctx.emitBoard();
  log("loop", `${scope}: reset to ${FLEET_LABELS.ready} for a fresh session`);
  // Best-effort: the ticket is already restarted, so a failed comment is worth
  // logging but not worth reporting back as a failed restart.
  try {
    await upsertStatusComment(project, issueNumber, [`**Status: restarting**`, RESTART_SUMMARY].join("\n\n"));
  } catch (err) {
    logError("loop", `${scope}: could not post the restart status comment`, err);
  }
}
