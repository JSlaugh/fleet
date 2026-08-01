import { FLEET_LABELS, type ProjectConfig } from "@fleet/shared";
import { key, track, type LoopContext } from "./context.ts";
import { closeIssue, markReady, upsertStatusComment } from "./github.ts";
import { Journal } from "./journal.ts";
import { log, logError } from "./log.ts";
import { resumeTicket } from "./runner.ts";

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
): Promise<"steered" | "resumed"> {
  const scope = key(projectName, issueNumber);
  // A human-driven session earns a fresh auto-recovery if it stalls.
  ctx.state.update(projectName, issueNumber, { autoResumed: false });

  const waiter = ctx.replyWaiters.get(scope);
  if (waiter) {
    waiter(message);
    return "steered";
  }

  const liveSession = ctx.live.get(scope);
  if (liveSession) {
    liveSession.send(message);
    log("loop", `${scope}: reply queued into running session`);
    return "steered";
  }

  const record = ctx.state.get(projectName, issueNumber);
  const project = ctx.getProject(projectName);
  if (!project) throw new Error(`unknown project ${projectName}`);
  if (!record?.sessionId) throw new Error(`no session recorded for ${scope}; label the issue fleet:ready to start fresh`);
  if (ctx.running.has(scope)) throw new Error(`${scope} is mid-transition; try again shortly`);
  if (ctx.isShuttingDown()) throw new Error(`daemon is shutting down; reply again once it's back up`);

  track(ctx, projectName, issueNumber, resumeTicket(ctx, project, record, message));
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

  await resetForFreshClaim(ctx, project, issueNumber);
}

/**
 * Closes a reviewed plan epic's issue — the completion signal `cleanupFinished`
 * (`board.ts`) needs to retire a PR-less plan record on the next poll cycle.
 * Validation (must be a plan, must be in review) is the route's job, since it
 * maps each failure to its own status code; this only guards the race the
 * route can't see — the ticket moving mid-request.
 */
export async function acceptPlan(ctx: LoopContext, projectName: string, issueNumber: number): Promise<void> {
  const scope = key(projectName, issueNumber);
  const project = ctx.getProject(projectName);
  if (!project) throw new Error(`unknown project ${projectName}`);
  if (ctx.running.has(scope)) throw new Error(`${scope} is mid-transition; try again shortly`);

  const record = ctx.state.get(projectName, issueNumber);
  const comment = [record?.lastSummary, "**Plan accepted by operator.**"].filter(Boolean).join("\n\n");
  try {
    await upsertStatusComment(project, issueNumber, comment);
  } catch (err) {
    logError("loop", `${scope}: could not post the plan-accepted status comment`, err);
  }
  await closeIssue(project, issueNumber);
  ctx.emitBoard();
  log("loop", `${scope}: plan accepted by operator — issue closed`);
}

/**
 * Drop everything that would make the next cycle resume rather than restart:
 * the recorded session id, the live flag, and the once-only auto-resume budget.
 * The journal file is kept — only an entry is appended — so the restarted
 * ticket's history stays readable in the dashboard.
 */
export async function resetForFreshClaim(ctx: LoopContext, project: ProjectConfig, issueNumber: number): Promise<void> {
  const scope = key(project.name, issueNumber);
  new Journal(ctx.dataDirPath, project.name, issueNumber).append({
    type: "fleet",
    event: "restarted-by-operator",
  });
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
    lastActivityAt: new Date().toISOString(),
    lastActivityNote: undefined,
  });
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
