import { FLEET_LABELS, type BoardTicket, type FleetConfig, type ModelUsageSummary, type ProjectConfig } from "@fleet/shared";
import type { ApprovalManager } from "./approvals.ts";
import { swapLabel } from "./github.ts";
import type { HistoryStore, StateStore } from "./state.ts";
import type { WorkerSession } from "./worker.ts";

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
  /** Runs in flight, keyed `project#issue` — the concurrency ledger. */
  readonly running: Map<string, Promise<void>>;
  /** Live sessions, same keys, for steering and aborting. */
  readonly live: Map<string, WorkerSession>;
  /** Keys whose session an operator is force-closing; see `finishFailed`. */
  readonly restarting: Set<string>;
  /** Resolvers for sessions parked after reporting `blocked`; `undefined` releases the park without a reply. */
  readonly replyWaiters: Map<string, (message: string | undefined) => void>;
  /** Last polled board tickets, per project. */
  readonly boardCache: Map<string, BoardTicket[]>;
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
