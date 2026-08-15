import type { BudgetGateLevel, BudgetStatus } from "@fleet/shared";
import type { LoopContext } from "./context.ts";

/**
 * Self-estimated spend gate over new claims, computed fresh each cycle from
 * the rolling spend ledger (`store/state.ts`). `level: "none"` when the
 * feature is off (`windowBudgetUsd` unset) or spend is under threshold.
 * Deliberately only ever consulted from the claim path (`claim.ts`) — resumes
 * and already-live sessions finish work already paid for, and the reactive
 * plan usage-limit pause (`pause.ts`) remains the hard backstop this
 * self-estimate can't be.
 */
export interface BudgetGate {
  level: BudgetGateLevel;
  spentUsd: number;
  budgetUsd?: number;
  windowHours: number;
}

export function computeBudgetGate(ctx: LoopContext): BudgetGate {
  const { windowBudgetUsd, usageWindowHours, budgetLightThreshold } = ctx.config;
  if (windowBudgetUsd === undefined) return { level: "none", spentUsd: 0, windowHours: usageWindowHours };
  const spentUsd = ctx.state.getWindowSpend(usageWindowHours);
  const level: BudgetGateLevel =
    spentUsd >= windowBudgetUsd ? "blocked" : spentUsd >= budgetLightThreshold * windowBudgetUsd ? "light-only" : "none";
  return { level, spentUsd, budgetUsd: windowBudgetUsd, windowHours: usageWindowHours };
}

/** The board payload's view of the gate — `undefined` (not just `level: "none"`) when the feature is off, so the dashboard can hide it entirely. */
export function budgetStatus(ctx: LoopContext): BudgetStatus | undefined {
  const gate = computeBudgetGate(ctx);
  if (gate.budgetUsd === undefined) return undefined;
  return { spentUsd: gate.spentUsd, budgetUsd: gate.budgetUsd, windowHours: gate.windowHours, gate: gate.level };
}

/**
 * Appends this cost increment to the daemon-wide spend ledger `computeBudgetGate`
 * reads — a no-op when the budget feature is off, so the ledger stays empty
 * unless it's actually used. `newTotalCostUsd` is the ticket's new cumulative
 * total; the delta versus what's currently recorded is what gets appended, so
 * every real dollar is counted exactly once no matter how many call sites
 * (per-turn writes, machine review spend) touch the same ticket's total.
 */
export function recordSpend(ctx: LoopContext, projectName: string, issueNumber: number, newTotalCostUsd: number): void {
  if (ctx.config.windowBudgetUsd === undefined) return;
  const prevCostUsd = ctx.state.get(projectName, issueNumber)?.costUsd ?? 0;
  const delta = newTotalCostUsd - prevCostUsd;
  if (delta > 0) ctx.state.appendSpend(delta, ctx.config.usageWindowHours);
}
