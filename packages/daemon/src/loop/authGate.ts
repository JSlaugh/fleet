import { TierSchema } from "@fleet/shared";
import type { LoopContext } from "./context.ts";
import { log } from "../log.ts";
import { runAuthProbe } from "../session/review.ts";
import { selectModel } from "./model.ts";

/** How long a cached probe result is trusted before the next cycle re-probes — cheap enough not to matter, but no reason to pay for a real session every poll. */
export const AUTH_PROBE_CACHE_MS = 15 * 60_000;

/** One probed model that came back unhealthy — `model` undefined means the CLI default. */
export interface ProbeFailure {
  model?: string;
  error?: string;
}

/** Pure freshness check, split out for direct unit testing without faking `Date.now()`. */
export function isProbeCacheFresh(cache: { checkedAt: number } | undefined, now: number): boolean {
  return !!cache && now - cache.checkedAt < AUTH_PROBE_CACHE_MS;
}

/**
 * Every distinct model a ticket session (or its reviewer) can run on, across
 * every project (fleet#234): each `fleet:elevate`/`fleet:light` label and each
 * `fleet.yaml` type tier, resolved through `selectModel` itself so an unset
 * field falls back exactly as a real session would. A type tier can only
 * resolve to one of `model`/`elevatedModel`/`lightModel`, so walking every
 * tier here covers it without reading any repo's `fleet.yaml`. `undefined`
 * (the CLI default) is included whenever some tier resolves to it — including
 * the no-project-sets-a-model case, which collapses to a single `[undefined]`.
 */
export function modelsToProbe(
  projects: readonly { model?: string; elevatedModel?: string; lightModel?: string }[],
): (string | undefined)[] {
  const models = new Set<string | undefined>();
  for (const project of projects) {
    models.add(selectModel(project, { elevated: true, light: false }));
    models.add(selectModel(project, { elevated: false, light: true }));
    for (const typeTier of [undefined, ...TierSchema.options]) {
      models.add(selectModel(project, { elevated: false, light: false, typeTier }));
    }
  }
  if (models.size === 0) models.add(undefined);
  return [...models];
}

function describeFailures(failures: ProbeFailure[]): string {
  return failures.map((f) => `${f.model ?? "(CLI default model)"}: ${f.error ?? "authentication failed"}`).join("; ");
}

/**
 * Machine-wide preflight gate (fleet#217, a refinement of fleet#215's
 * reactive detection; per-model since fleet#234): runs (or reuses a cached)
 * cheap one-turn probe session for every model in `modelsToProbe`,
 * concurrently, then decides whether every project's claims and stall
 * resumes should hold this cycle — held if any one model is unhealthy, since
 * a dead login and a model/CLI-version rejection both fail every ticket
 * routed to it on turn 1. Same shape as `computeBudgetGate`/
 * `computeWorkHoursReserveGate`, except the probe is async and the
 * environment is daemon-wide, so this runs once in `FleetLoop.cycle()`
 * before `recoverStalled` and the per-project loop. Logs and records a
 * `gate-hold-auth-probe` state event, naming the failing model(s) and their
 * API error text, once per hold spell (dedup via `ctx.authGateNotified`),
 * releasing it the moment every probe comes back healthy — no operator
 * action needed, unlike #215's reactive pause.
 */
export async function checkAuthGate(ctx: LoopContext): Promise<boolean> {
  const now = Date.now();
  if (!isProbeCacheFresh(ctx.authProbeCache, now)) {
    const models = modelsToProbe(ctx.config.projects);
    const outcomes = await Promise.all(
      models.map((model) => runAuthProbe({ model, claudeExecutable: ctx.config.claudeExecutable })),
    );
    const failures: ProbeFailure[] = outcomes.flatMap((outcome, i) =>
      outcome.healthy ? [] : [{ model: models[i], error: outcome.error }],
    );
    ctx.authProbeCache = { healthy: failures.length === 0, checkedAt: now, failures };
  }
  const cache = ctx.authProbeCache!;

  if (cache.healthy) {
    ctx.authGateNotified.delete("held");
    ctx.authGateHeld = false;
    return false;
  }
  if (!ctx.authGateNotified.has("held")) {
    ctx.authGateNotified.add("held");
    const failures = cache.failures ?? [];
    const detail = `preflight probe failed (${describeFailures(failures)}) — holding claims and stall resumes for every project until every model probes healthy`;
    log("loop", `auth gate: ${detail}`);
    ctx.state.appendEvent("gate-hold-auth-probe", { data: { detail, failures } });
  }
  ctx.authGateHeld = true;
  return true;
}

/**
 * Invalidates the cached probe result — called from fleet#215's reactive
 * `pauseForAuthFailure` and fleet#234's `handleEnvironmentRejection` so an
 * environment that breaks mid-run is reflected by the very next cycle's
 * probe instead of riding out the rest of the cache window.
 */
export function invalidateAuthProbeCache(ctx: LoopContext): void {
  ctx.authProbeCache = undefined;
}
