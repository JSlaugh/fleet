import { FLEET_LABELS, type BoardTicket, type FleetConfig, type ModelUsageSummary, type ProjectConfig } from "@fleet/shared";
import type { ApprovalManager } from "../session/approvals.ts";
import { swapLabel } from "../github/github.ts";
import type { HistoryStore, StateStore } from "../store/state.ts";
import type { WorkerSession } from "../session/worker.ts";

/** Cost and per-model usage a ticket had accrued before the current session started. */
export interface SessionBase {
  costUsd: number;
  modelUsage?: Record<string, ModelUsageSummary>;
}

/**
 * Everything the loop's modules share. `FleetLoop` owns this object and stays a
 * thin coordinator; each concern (claiming, supervising, recovery, reviews,
 * board projection, operator actions) is a module of plain functions taking it
 * as their first argument.
 */
export interface LoopContext {
  readonly config: FleetConfig;
  readonly state: StateStore;
  readonly history: HistoryStore;
  readonly dataDirPath: string;
  readonly approvals: ApprovalManager;
  readonly dryRun: boolean;
  /** `--once` runs have no dashboard server, so approvals can never be answered — auto-deny instead of waiting out `approvalTimeoutMinutes`. */
  readonly once: boolean;
  /** Runs in flight, keyed `project#issue` — the concurrency ledger. */
  readonly running: Map<string, Promise<void>>;
  /** Live sessions, same keys, for steering and aborting. */
  readonly live: Map<string, WorkerSession>;
  /** Keys whose session an operator is force-closing; see `finishFailed`. */
  readonly restarting: Set<string>;
  /** Keys whose session a daemon stop-now is aborting; see `finishFailed`. */
  readonly stopping: Set<string>;
  /**
   * Live (not snapshotted) check for an in-progress daemon shutdown, of
   * either mode. `cycle()`'s `paused` is computed once at the top of a cycle
   * and threaded through several `await`s, so it can go stale mid-cycle;
   * anything about to `track()` new work should check this instead, right
   * before doing so, so a shutdown requested mid-cycle is seen immediately.
   */
  isShuttingDown(): boolean;
  /** Resolvers for sessions parked after reporting `blocked`; `undefined` releases the park without a reply. */
  readonly replyWaiters: Map<string, (message: string | undefined) => void>;
  /** Last polled board tickets, per project. */
  readonly boardCache: Map<string, BoardTicket[]>;
  /** `project#issue` keys already logged as skipped for a non-collaborator author — logged once per issue, not once per cycle. */
  readonly contributorFloorSkipsLogged: Set<string>;
  /** Project names currently notified about a budget-gate `blocked` hold — cleared once the gate lifts, so only the first hold of a spell notifies, not every poll while it persists. */
  readonly budgetBlockedNotified: Set<string>;
  /** Project names for which the current work-hours reserve spell has already logged a digest event — cleared once the gate lifts, same dedup shape as `budgetBlockedNotified`. */
  readonly workHoursReserveNotified: Set<string>;
  emitBoard(): void;
  getProject(name: string): ProjectConfig | undefined;
}

/** The `project#issue` key every in-flight map in `LoopContext` is keyed by. */
export function key(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}

/** How many of `runningKeys` belong to `projectName` — the count `maxConcurrent` is measured against. */
export function countRunning(runningKeys: Iterable<string>, projectName: string): number {
  return [...runningKeys].filter((k) => k.startsWith(`${projectName}#`)).length;
}

/** Registers a run in the concurrency ledger, clearing it once the run settles. */
export function track(ctx: LoopContext, projectName: string, issueNumber: number, promise: Promise<void>): void {
  const runKey = key(projectName, issueNumber);
  ctx.running.set(runKey, promise.finally(() => ctx.running.delete(runKey)));
}

/**
 * Puts a ticket back into `fleet:in-progress` and marks it running — the entry
 * point of every resume. The label swap is left to throw (see the error policy
 * on `swapLabel`); callers already run inside a try/catch that reports the
 * failure and leaves the ticket in its prior state rather than marking it
 * running under a label that never actually changed.
 */
export async function markWorking(ctx: LoopContext, project: ProjectConfig, issueNumber: number): Promise<void> {
  await swapLabel(project, issueNumber, FLEET_LABELS.needsInput, FLEET_LABELS.inProgress);
  // Stamp activity too: a resumed ticket whose last activity is already past the
  // stall cutoff would otherwise be re-flagged as stalled before its first message.
  ctx.state.update(project.name, issueNumber, { status: "running", lastActivityAt: new Date().toISOString() });
  ctx.emitBoard();
}
