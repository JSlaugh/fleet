import type { LoopContext } from "./context.ts";
import { log } from "../log.ts";
import { runAuthProbe } from "../session/review.ts";

/** How long a cached probe result is trusted before the next cycle re-probes — cheap enough not to matter, but no reason to pay for a real session every poll. */
export const AUTH_PROBE_CACHE_MS = 15 * 60_000;

/** Pure freshness check, split out for direct unit testing without faking `Date.now()`. */
export function isProbeCacheFresh(cache: { checkedAt: number } | undefined, now: number): boolean {
  return !!cache && now - cache.checkedAt < AUTH_PROBE_CACHE_MS;
}

/**
 * Machine-wide preflight auth gate (fleet#217, a refinement of fleet#215's
 * reactive detection): runs (or reuses a cached) cheap one-turn probe
 * session, then decides whether every project's claims should hold this
 * cycle — same shape as `computeBudgetGate`/`computeWorkHoursReserveGate`,
 * except the probe is async and credentials are daemon-wide rather than
 * per-project, so this runs once in `FleetLoop.cycle()` before the
 * per-project loop instead of once per project. Logs and records a
 * `gate-hold-auth-probe` state event once per hold spell (dedup via
 * `ctx.authGateNotified`), releasing it the moment a probe comes back
 * healthy — no operator action needed, unlike #215's reactive pause.
 */
export async function checkAuthGate(ctx: LoopContext): Promise<boolean> {
  const now = Date.now();
  if (!isProbeCacheFresh(ctx.authProbeCache, now)) {
    const project = ctx.config.projects[0];
    const outcome = await runAuthProbe({
      model: project?.lightModel ?? project?.model,
      claudeExecutable: ctx.config.claudeExecutable,
    });
    ctx.authProbeCache = { healthy: outcome.healthy, checkedAt: now };
  }
  const held = !ctx.authProbeCache!.healthy;

  if (!held) {
    ctx.authGateNotified.delete("held");
    ctx.authGateHeld = false;
    return false;
  }
  if (!ctx.authGateNotified.has("held")) {
    ctx.authGateNotified.add("held");
    const detail = "authentication probe failed — holding claims for every project until credentials recover";
    log("loop", `auth gate: ${detail}`);
    ctx.state.appendEvent("gate-hold-auth-probe", { data: { detail } });
  }
  ctx.authGateHeld = true;
  return true;
}

/**
 * Invalidates the cached probe result — called from fleet#215's reactive
 * `pauseForAuthFailure` so a credential that dies mid-run is reflected by the
 * very next cycle's probe instead of riding out the rest of the cache
 * window.
 */
export function invalidateAuthProbeCache(ctx: LoopContext): void {
  ctx.authProbeCache = undefined;
}
