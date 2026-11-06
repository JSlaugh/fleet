import type { TicketRecord } from "@fleet/shared";
import { activeCount, countRunning, key, track, type LoopContext } from "./context.ts";
import { log } from "../log.ts";
import { isProjectPaused } from "./pause.ts";
import { Journal } from "../store/journal.ts";
import { FAILURE_RETRY_REASON, STALL_RESUME_REASON, resumeTicket } from "./runner.ts";

const STALL_NUDGE = [
  "Your session was interrupted.",
  "Inspect the current state of the worktree (git status, git log) to see what has already been done, then continue the ticket.",
  "If you had already finished, produce your final structured result again.",
].join(" ");

/**
 * The opening message of a failure-retry resume (fleet#238): the failed run's
 * own instructions again, so the review feedback or conflict it was resumed
 * for still gets addressed. Falls back to the stall nudge when nothing was
 * recorded (the failed run wasn't a resume).
 */
export function buildFailureRetryPrompt(resumePrompt: string | undefined): string {
  if (!resumePrompt) return STALL_NUDGE;
  return [
    "Your previous attempt at the request below ended before it finished. Inspect the worktree (git status, git log) to see what has already been done, then carry it out and produce your final structured result.",
    resumePrompt,
  ].join("\n\n");
}

/**
 * Stalled tickets that should be auto-resumed for `project`: they have a session
 * to resume, are not already in flight, and have not been auto-resumed before
 * (a second stall is left for a human). Capped by the project's `maxConcurrent`,
 * counting tickets already running — minus any yielded on a long-pending
 * approval, when the caller passes `activeRunning` (see `countActive`).
 */
export function pickAutoResumable(
  records: TicketRecord[],
  project: { name: string; maxConcurrent: number },
  runningKeys: Iterable<string>,
  activeRunning?: number,
): TicketRecord[] {
  const running = new Set(runningKeys);
  const capacity = project.maxConcurrent - (activeRunning ?? countRunning(running, project.name));
  if (capacity <= 0) return [];
  return records
    .filter(
      (record) =>
        record.project === project.name &&
        record.status === "stalled" &&
        !!record.sessionId &&
        !record.autoResumed &&
        !running.has(key(record.project, record.issueNumber)),
    )
    .slice(0, capacity);
}

/**
 * Marks tickets with no activity since the cutoff as stalled, so `recoverStalled`
 * can pick them up. Skips a ticket with a pending tool approval: a parked
 * approval produces no SDK messages by design (fleet#225 pauses the turn clock
 * for exactly this wait), so "no activity" there means "waiting on a human,"
 * not "stuck."
 */
export function flagStalled(ctx: LoopContext): void {
  const cutoff = Date.now() - ctx.config.stalledAfterMinutes * 60_000;
  const awaitingApproval = new Set(ctx.approvals.list().map((a) => key(a.project, a.issueNumber)));
  for (const ticket of ctx.state.all()) {
    if (awaitingApproval.has(key(ticket.project, ticket.issueNumber))) continue;
    if (ticket.status === "running" && Date.parse(ticket.lastActivityAt) < cutoff) {
      ctx.state.update(ticket.project, ticket.issueNumber, { status: "stalled" });
      log("loop", `${key(ticket.project, ticket.issueNumber)}: STALLED (no activity since ${ticket.lastActivityAt})`);
      new Journal(ctx.dataDirPath, ticket.project, ticket.issueNumber).append({
        type: "fleet",
        event: "stalled",
        lastActivityAt: ticket.lastActivityAt,
      });
    }
  }
}

/**
 * Resume stalled tickets that still have a session, once each. Covers both boot
 * reconciliation (`clearLiveFlags` turns orphaned `running` tickets into
 * `stalled`) and mid-run stalls flagged by `flagStalled`. A project the
 * operator has paused (daemon-wide or individually) is skipped entirely —
 * its stalled tickets stay stalled until the pause lifts. Likewise while the
 * preflight gate is held (`checkAuthGate`): a ticket stalled on an
 * environment rejection (fleet#234) resumes only once every model probes
 * healthy again.
 */
export function recoverStalled(ctx: LoopContext): void {
  if (ctx.authGateHeld) return;
  for (const project of ctx.config.projects) {
    if (isProjectPaused(ctx, project.name)) continue;
    for (const record of pickAutoResumable(ctx.state.all(), project, ctx.running.keys(), activeCount(ctx, project.name).active)) {
      const scope = key(record.project, record.issueNumber);
      if (ctx.dryRun) {
        log("loop", `[dry-run] would auto-resume stalled ${scope} from session ${record.sessionId}`);
        continue;
      }
      // A fresh check right before `track()` (nothing awaited in between,
      // unlike `cycle()`'s `paused` snapshot) so a shutdown requested
      // mid-cycle can't have this slip past `stopLiveSessions`'s sweep.
      if (ctx.isShuttingDown()) return;
      const retry = record.failureRetry === "pending";
      log(
        "loop",
        retry
          ? `${scope}: failed with an open PR — auto-resuming session ${record.sessionId} with its last instructions (once)`
          : `${scope}: stalled — auto-resuming session ${record.sessionId} (once)`,
      );
      const updated =
        ctx.state.update(record.project, record.issueNumber, { autoResumed: true, ...(retry ? { failureRetry: "used" as const } : {}) }) ?? record;
      const message = retry ? buildFailureRetryPrompt(record.resumePrompt) : STALL_NUDGE;
      track(ctx, record.project, record.issueNumber, resumeTicket(ctx, project, updated, message, retry ? FAILURE_RETRY_REASON : STALL_RESUME_REASON));
    }
  }
}
