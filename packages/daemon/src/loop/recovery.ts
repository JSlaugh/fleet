import type { TicketRecord } from "@fleet/shared";
import { countRunning, key, track, type LoopContext } from "./context.ts";
import { log } from "../log.ts";
import { isProjectPaused } from "./pause.ts";
import { Journal } from "../store/journal.ts";
import { resumeTicket } from "./runner.ts";

const STALL_NUDGE = [
  "Your session was interrupted.",
  "Inspect the current state of the worktree (git status, git log) to see what has already been done, then continue the ticket.",
  "If you had already finished, produce your final structured result again.",
].join(" ");

/**
 * Stalled tickets that should be auto-resumed for `project`: they have a session
 * to resume, are not already in flight, and have not been auto-resumed before
 * (a second stall is left for a human). Capped by the project's `maxConcurrent`,
 * counting tickets already running.
 */
export function pickAutoResumable(
  records: TicketRecord[],
  project: { name: string; maxConcurrent: number },
  runningKeys: Iterable<string>,
): TicketRecord[] {
  const running = new Set(runningKeys);
  const capacity = project.maxConcurrent - countRunning(running, project.name);
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

/** Marks tickets with no activity since the cutoff as stalled, so `recoverStalled` can pick them up. */
export function flagStalled(ctx: LoopContext): void {
  const cutoff = Date.now() - ctx.config.stalledAfterMinutes * 60_000;
  for (const ticket of ctx.state.all()) {
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
 * its stalled tickets stay stalled until the pause lifts.
 */
export function recoverStalled(ctx: LoopContext): void {
  for (const project of ctx.config.projects) {
    if (isProjectPaused(ctx, project.name)) continue;
    for (const record of pickAutoResumable(ctx.state.all(), project, ctx.running.keys())) {
      const scope = key(record.project, record.issueNumber);
      if (ctx.dryRun) {
        log("loop", `[dry-run] would auto-resume stalled ${scope} from session ${record.sessionId}`);
        continue;
      }
      // A fresh check right before `track()` (nothing awaited in between,
      // unlike `cycle()`'s `paused` snapshot) so a shutdown requested
      // mid-cycle can't have this slip past `stopLiveSessions`'s sweep.
      if (ctx.isShuttingDown()) return;
      log("loop", `${scope}: stalled — auto-resuming session ${record.sessionId} (once)`);
      const updated = ctx.state.update(record.project, record.issueNumber, { autoResumed: true }) ?? record;
      track(ctx, record.project, record.issueNumber, resumeTicket(ctx, project, updated, STALL_NUDGE, "stall"));
    }
  }
}
