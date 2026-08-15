import type { ProjectConfig } from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import { upsertStatusComment } from "../github/github.ts";
import { log, logError } from "../log.ts";
import type { ReadyIssue } from "../github/github.ts";

/**
 * True while claims and resumes should be skipped: either an operator-initiated
 * drain (`paused`) or a plan usage-limit pause (`pausedUntil` in the future).
 * Board polling and cleanup still run either way.
 */
export function isPaused(ctx: LoopContext): boolean {
  if (ctx.state.getPaused()) return true;
  const pausedUntil = ctx.state.getPausedUntil();
  return !!pausedUntil && Date.now() < Date.parse(pausedUntil);
}

/** Operator-initiated pause toggle (drain mode) — persists across restarts until explicitly resumed. */
export function setPaused(ctx: LoopContext, paused: boolean): void {
  ctx.state.setPaused(paused);
  log("loop", paused ? "daemon paused — draining, no new claims or resumes" : "daemon resumed — claiming and resuming as normal");
  ctx.emitBoard();
}

/** Clears an expired pause; called once at the top of every cycle before anything checks `isPaused`. */
export function updatePauseState(ctx: LoopContext): void {
  const pausedUntil = ctx.state.getPausedUntil();
  if (pausedUntil && Date.now() >= Date.parse(pausedUntil)) {
    ctx.state.setPausedUntil(undefined);
    log("loop", `plan usage-limit pause lifted (was paused until ${pausedUntil})`);
    ctx.emitBoard();
  }
}

/** Extends the daemon-wide plan-limit pause (never shortens an existing one). Returns the effective pause end. */
export function extendPause(ctx: LoopContext, scope: string, limitResetAt: string | undefined): Date {
  const resetAt = limitResetAt ? new Date(limitResetAt) : new Date(Date.now() + ctx.config.limitDefaultBackoffMinutes * 60_000);
  const pausedUntil = new Date(resetAt.getTime() + ctx.config.limitResumeSlackMinutes * 60_000);

  const existing = ctx.state.getPausedUntil();
  if (!existing || pausedUntil.getTime() > Date.parse(existing)) {
    ctx.state.setPausedUntil(pausedUntil.toISOString());
    log("loop", `${scope}: plan usage limit hit — pausing daemon until ${pausedUntil.toISOString()}`);
  } else {
    log("loop", `${scope}: plan usage limit hit again — existing pause until ${existing} already covers it`);
  }
  return pausedUntil;
}

/**
 * A plan usage-limit hit isn't the ticket's fault and isn't retryable right now: every
 * session across every project would fail the same way until the plan's window resets.
 * Rather than failing the ticket, pause the whole daemon and leave this ticket `stalled`
 * with its session id intact so `recoverStalled` resumes it automatically once the pause
 * lifts — clearing `autoResumed` so the once-only stall guard doesn't swallow that resume.
 */
export async function handlePlanLimit(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: ReadyIssue,
  limitResetAt: string | undefined,
): Promise<void> {
  const scope = key(project.name, issue.number);
  const pausedUntil = extendPause(ctx, scope, limitResetAt);

  ctx.state.update(project.name, issue.number, {
    status: "stalled",
    lastActivityNote: `paused: plan limit until ${pausedUntil.toLocaleString()}`,
    autoResumed: false,
  });
  ctx.emitBoard();

  try {
    await upsertStatusComment(
      project,
      issue.number,
      [`**Status: paused**`, `Plan usage limit reached — resuming automatically ~${pausedUntil.toLocaleString()}.`].join("\n\n"),
    );
  } catch (err) {
    logError("loop", `${scope}: could not post the plan-limit pause status comment`, err);
  }
}
