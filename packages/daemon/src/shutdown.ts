import type { LoopContext } from "./context.ts";
import { log } from "./log.ts";

/** How long stop-now spends aborting sessions — including ones that start after the first sweep — before giving up. */
const STOP_DRAIN_MS = 30_000;
/** How often to re-scan `ctx.live` for a session that starts after the previous sweep. */
const SWEEP_INTERVAL_MS = 200;

/**
 * Resolves when `promise` settles or `ms` elapses — whichever is first, never
 * rejecting. `ms <= 0` (the drain window already ran out) resolves right away
 * instead of arming a zero-delay timer: scheduled exactly at the edge of the
 * budget a caller advanced fake timers by, such a timer isn't guaranteed to
 * fire within that same advancement, which would hang a test forever instead
 * of giving up as intended.
 */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Stop-now: abort every live session immediately instead of waiting for a
 * turn to finish. The `isShuttingDown` checks in `claim.ts`/`recovery.ts`/
 * `reviews.ts`/`operator.ts` stop a *new* `cycle()` or dashboard reply from
 * starting a session once shutdown begins, but a `cycle()` already mid-flight
 * at that moment can still finish claiming or auto-resuming one more ticket —
 * so this doesn't just sweep `ctx.live` once, it keeps re-scanning for
 * newly-appeared sessions every `SWEEP_INTERVAL_MS`, aborting each as soon as
 * it's seen, until nothing is pending and a full sweep turns up nothing new
 * (or `STOP_DRAIN_MS` runs out — the caller exits the process right after, so
 * a wedged session just gets killed along with everything else at that point).
 *
 * Marking a scope in `ctx.stopping` before aborting steers `finishFailed` away
 * from reporting the aborted turn as a failure — it leaves the ticket
 * `stalled` with its `sessionId` intact and `autoResumed` cleared instead, so
 * the next boot's auto-resume picks it up for free.
 */
export async function stopLiveSessions(ctx: LoopContext): Promise<void> {
  const deadline = Date.now() + STOP_DRAIN_MS;
  const handled = new Set<string>();
  const drains: Promise<void>[] = [];
  let pending = 0;

  const abortNewlyLive = (): number => {
    let discovered = 0;
    for (const [scope, session] of ctx.live) {
      if (handled.has(scope)) continue;
      handled.add(scope);
      discovered++;
      pending++;
      ctx.stopping.add(scope);
      log("loop", `${scope}: daemon stop-now — aborting session ${session.sessionId ?? "(not yet started)"}`);
      session.abortController.abort();
      // A session parked after reporting `blocked` is waiting on a reply, not
      // on the SDK, so it would ignore the abort for the rest of `replyWaitMinutes`.
      ctx.replyWaiters.get(scope)?.(undefined);
      // Only clear `stopping` (and count this settled) once the ticket's own
      // run has actually finished — a wedged session that errors out much
      // later must still not report a failure just because the drain window
      // below gave up waiting on it.
      const inFlight = ctx.running.get(scope) ?? Promise.resolve();
      drains.push(
        inFlight.then(
          () => {
            ctx.stopping.delete(scope);
            pending--;
          },
          () => {
            ctx.stopping.delete(scope);
            pending--;
          },
        ),
      );
    }
    return discovered;
  };

  abortNewlyLive();
  while (Date.now() < deadline) {
    await delay(Math.min(SWEEP_INTERVAL_MS, deadline - Date.now()));
    const discovered = abortNewlyLive();
    if (pending === 0 && discovered === 0) break;
  }
  await settleWithin(Promise.all(drains), Math.max(0, deadline - Date.now()));
}
