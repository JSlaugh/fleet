import type { TicketRecord } from "@fleet/shared";
import { computeBudgetGate } from "./budget.ts";
import { activeCount, countRunning, key, track, type LoopContext } from "./context.ts";
import { log } from "../log.ts";
import { isProjectPaused } from "./pause.ts";
import { resumeTicket } from "./runner.ts";
import { computeWorkHoursReserveGate } from "./workHoursReserve.ts";

/** The message a waiting ticket's session is resumed with. */
export function buildWaitNudge(reason: string | undefined): string {
  return [
    reason ? `You said you were waiting on: ${reason}.` : "You finished your last turn as waiting.",
    "Check whether it's done and continue the ticket.",
    "If it still isn't done, finish as \"waiting\" again with an updated waitReason; if a human decision is now needed, finish as \"blocked\".",
  ].join(" ");
}

/**
 * Waiting tickets due for their automatic resume (fleet#236): `resumeAt` has
 * passed, they have a session to resume, and they are not already in flight.
 * Oldest `resumeAt` first, capped by `maxConcurrent` the same way
 * `pickAutoResumable` is — counting tickets already running, minus any
 * yielded on a long-pending approval when the caller passes `activeRunning`.
 */
export function pickWaitingDue(
  records: TicketRecord[],
  project: { name: string; maxConcurrent: number },
  runningKeys: Iterable<string>,
  now: number,
  activeRunning?: number,
): TicketRecord[] {
  const running = new Set(runningKeys);
  const capacity = project.maxConcurrent - (activeRunning ?? countRunning(running, project.name));
  if (capacity <= 0) return [];
  return records
    .filter(
      (record) =>
        record.project === project.name &&
        record.status === "waiting" &&
        !!record.sessionId &&
        !!record.resumeAt &&
        Date.parse(record.resumeAt) <= now &&
        !running.has(key(record.project, record.issueNumber)),
    )
    .sort((a, b) => Date.parse(a.resumeAt!) - Date.parse(b.resumeAt!))
    .slice(0, capacity);
}

/**
 * Resume every waiting ticket whose `resumeAt` has passed, under the same
 * holds as any other new work: the preflight auth gate, operator/plan-limit
 * pauses (daemon-wide or per-project), the budget gate's `blocked` level, the
 * work-hours reserve, a shutdown in progress, and dry-run. A held ticket just
 * stays `waiting` and is picked up on a later cycle once the hold lifts.
 *
 * Each resume counts toward `waitResumes`, the consecutive-wait cap
 * `finishWaiting` enforces; a human reply resets it (`reply()`).
 */
export function resumeWaiting(ctx: LoopContext): void {
  if (ctx.authGateHeld) return;
  if (computeBudgetGate(ctx).level === "blocked") return;
  if (computeWorkHoursReserveGate(ctx).active) return;
  const now = Date.now();
  for (const project of ctx.config.projects) {
    if (isProjectPaused(ctx, project.name)) continue;
    for (const record of pickWaitingDue(ctx.state.all(), project, ctx.running.keys(), now, activeCount(ctx, project.name).active)) {
      const scope = key(record.project, record.issueNumber);
      if (ctx.dryRun) {
        log("loop", `[dry-run] would resume waiting ${scope} from session ${record.sessionId} (waiting on: ${record.waitReason ?? "unspecified"})`);
        continue;
      }
      // Same fresh check right before `track()` as `recoverStalled`.
      if (ctx.isShuttingDown()) return;
      const waitResumes = (record.waitResumes ?? 0) + 1;
      log("loop", `${scope}: wait over — resuming session ${record.sessionId} (automatic wait resume ${waitResumes}/${ctx.config.maxWaitResumes})`);
      const updated =
        ctx.state.update(record.project, record.issueNumber, { waitResumes, resumeAt: undefined, waitReason: undefined }) ?? record;
      track(ctx, record.project, record.issueNumber, resumeTicket(ctx, project, updated, buildWaitNudge(record.waitReason), "wait-resume"));
    }
  }
}
