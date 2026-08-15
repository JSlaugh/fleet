// Plain-Node policy for `fleet-supervisor.mjs` — pure and dependency-free so it
// can be unit tested without spawning a real child process. Must agree with
// `packages/daemon/src/restart-code.ts`'s `RESTART_EXIT_CODE`; that file can't
// be imported here since this script runs without a TS/tsx step.
export const RESTART_EXIT_CODE = 87;
export const BASE_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const STABLE_UPTIME_MS = 10 * 60_000;

/**
 * Given the daemon child process's exit code and how long it stayed up this
 * run, decides what the supervisor does next. `backoffMs` is the delay that
 * *would* apply to the next crash if the daemon doesn't stay up long enough
 * to reset it — the caller threads its own `nextBackoffMs` back in as
 * `backoffMs` on the following call.
 *
 * - exit 0 (clean stop: operator shutdown, SIGINT/SIGTERM, `--once`) → stop,
 *   don't relaunch.
 * - exit RESTART_EXIT_CODE (87, restart requested) → relaunch immediately and
 *   reset backoff, since this isn't a crash.
 * - any other nonzero (crash) → relaunch after `delayMs`, doubling backoff
 *   for the next crash unless this run stayed up `STABLE_UPTIME_MS`+, in
 *   which case backoff resets to `BASE_BACKOFF_MS`.
 */
export function decideNextAction({ code, uptimeMs, backoffMs }) {
  if (code === 0) return { action: "stop" };
  if (code === RESTART_EXIT_CODE) return { action: "relaunch", delayMs: 0, nextBackoffMs: BASE_BACKOFF_MS };

  const stable = uptimeMs >= STABLE_UPTIME_MS;
  const delayMs = stable ? BASE_BACKOFF_MS : backoffMs;
  const nextBackoffMs = Math.min(delayMs * 2, MAX_BACKOFF_MS);
  return { action: "relaunch", delayMs, nextBackoffMs };
}
