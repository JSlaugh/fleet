import type { LoopContext } from "./context.ts";
import { log } from "./log.ts";

/** How long stop-now waits for aborted sessions to unwind before giving up and moving on anyway. */
const STOP_DRAIN_MS = 30_000;

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
 * Stop-now: abort every live session immediately instead of waiting for a turn
 * to finish. Marking each scope in `ctx.stopping` before aborting steers
 * `finishFailed` away from reporting the aborted turn as a failure — it leaves
 * the ticket `stalled` with its `sessionId` intact and `autoResumed` cleared
 * instead, so the next boot's auto-resume picks it up for free. Waits up to
 * `STOP_DRAIN_MS` for the aborts to unwind before returning anyway, mirroring
 * `restartTicket`'s `ABORT_DRAIN_MS` — the caller exits the process right
 * after, so a wedged session just gets killed along with everything else.
 */
export async function stopLiveSessions(ctx: LoopContext): Promise<void> {
  const drains: Promise<void>[] = [];
  for (const [scope, session] of ctx.live) {
    ctx.stopping.add(scope);
    log("loop", `${scope}: daemon stop-now — aborting session ${session.sessionId ?? "(not yet started)"}`);
    session.abortController.abort();
    // A session parked after reporting `blocked` is waiting on a reply, not on
    // the SDK, so it would ignore the abort for the rest of `replyWaitMinutes`.
    ctx.replyWaiters.get(scope)?.(undefined);
    // Only clear `stopping` once this ticket's own run has actually settled —
    // a wedged session that errors out much later must still not report a
    // failure just because the drain window below gave up waiting on it.
    const clear = () => void ctx.stopping.delete(scope);
    const inFlight = ctx.running.get(scope) ?? Promise.resolve();
    drains.push(inFlight.then(clear, clear));
  }
  await settleWithin(Promise.all(drains), STOP_DRAIN_MS);
}
