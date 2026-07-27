import { EventEmitter } from "node:events";
import type { BoardTicket, ClosedTicketRecord, FleetConfig, ProjectConfig } from "@fleet/shared";
import type { ApprovalManager } from "./approvals.ts";
import { cleanupFinished, getBoard } from "./board.ts";
import { cycleProject } from "./claim.ts";
import type { LoopContext, SessionBase } from "./context.ts";
import { finishBlocked, finishCompleted, finishFailed } from "./finish.ts";
import type { ReadyIssue } from "./github.ts";
import { logError } from "./log.ts";
import { reply, resetForFreshClaim, restartTicket } from "./operator.ts";
import { handlePlanLimit, isPaused, updatePauseState } from "./pause.ts";
import { flagStalled, recoverStalled } from "./recovery.ts";
import { HistoryStore, StateStore } from "./state.ts";
import { machineReviewGate } from "./supervise.ts";
import { TrailingThrottle } from "./throttle.ts";
import type { WorkerSession } from "./worker.ts";
import type { Worktree } from "./worktree.ts";

/**
 * The daemon's poll loop and the owner of all shared loop state. Every concern
 * — claiming (`claim.ts`), running sessions (`runner.ts`), supervising them
 * (`supervise.ts`, `finish.ts`), stall and pause policy (`recovery.ts`,
 * `pause.ts`), PR review feedback (`reviews.ts`), board projection
 * (`board.ts`) and operator actions (`operator.ts`) — lives in its own module
 * as plain functions over the `LoopContext` this class assembles.
 */
export class FleetLoop {
  private readonly running = new Map<string, Promise<void>>();
  private readonly live = new Map<string, WorkerSession>();
  /** Keys whose session an operator is force-closing; see `finishFailed`. */
  private readonly restarting = new Set<string>();
  /** Resolvers for sessions parked after reporting `blocked`; `undefined` releases the park without a reply. */
  private readonly replyWaiters = new Map<string, (message: string | undefined) => void>();
  private readonly boardCache = new Map<string, BoardTicket[]>();
  private readonly boardThrottle = new TrailingThrottle(1000, () => this.events.emit("board"));
  private readonly history: HistoryStore;
  private readonly ctx: LoopContext;
  readonly events = new EventEmitter();

  constructor(
    private readonly config: FleetConfig,
    state: StateStore,
    dataDirPath: string,
    approvals: ApprovalManager,
    dryRun: boolean,
    once: boolean = false,
  ) {
    this.history = new HistoryStore(dataDirPath);
    this.ctx = {
      config,
      state,
      history: this.history,
      dataDirPath,
      approvals,
      dryRun,
      once,
      running: this.running,
      live: this.live,
      restarting: this.restarting,
      replyWaiters: this.replyWaiters,
      boardCache: this.boardCache,
      emitBoard: () => this.boardThrottle.trigger(),
      getProject: (name) => this.getProject(name),
    };
  }

  async cycle(): Promise<void> {
    this.flagStalled();
    this.updatePauseState();
    const paused = this.isPaused();
    if (!paused) this.recoverStalled();
    for (const project of this.config.projects) {
      try {
        await cycleProject(this.ctx, project, paused);
      } catch (err) {
        logError("loop", `polling ${project.name} failed`, err);
      }
    }
  }

  async reply(projectName: string, issueNumber: number, message: string): Promise<"steered" | "resumed"> {
    return reply(this.ctx, projectName, issueNumber, message);
  }

  async restartTicket(projectName: string, issueNumber: number): Promise<void> {
    return restartTicket(this.ctx, projectName, issueNumber);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  get activeCount(): number {
    return this.running.size;
  }

  getBoard(): BoardTicket[] {
    return getBoard(this.ctx);
  }

  getProject(name: string): ProjectConfig | undefined {
    return this.config.projects.find((p) => p.name === name);
  }

  getHistoryRecord(project: string, issueNumber: number): ClosedTicketRecord | undefined {
    return this.history.get(project, issueNumber);
  }

  // ── Delegations ──────────────────────────────────────────────────────────
  // One method per loop operation, so `FleetLoop` stays the single handle on
  // the machine even for the steps the modules now drive between themselves.
  // Not dead code: `loop.*.test.ts` exercises these through the instance.

  private flagStalled(): void {
    flagStalled(this.ctx);
  }

  private recoverStalled(): void {
    recoverStalled(this.ctx);
  }

  private isPaused(): boolean {
    return isPaused(this.ctx);
  }

  private updatePauseState(): void {
    updatePauseState(this.ctx);
  }

  private handlePlanLimit(project: ProjectConfig, issue: ReadyIssue, limitResetAt: string | undefined): Promise<void> {
    return handlePlanLimit(this.ctx, project, issue, limitResetAt);
  }

  private machineReviewGate(
    project: ProjectConfig,
    issue: ReadyIssue,
    worktree: Worktree,
    base: SessionBase,
  ): Promise<{ action: "proceed" } | { action: "fixing"; prompt: string }> {
    return machineReviewGate(this.ctx, project, issue, worktree, base);
  }

  private finishCompleted(
    project: ProjectConfig,
    issue: ReadyIssue,
    worktreePath: string,
    branch: string,
    summary: string,
    result: { prTitle?: string; prBody?: string; filesChanged: string[]; confidence: string },
  ): Promise<void> {
    return finishCompleted(this.ctx, project, issue, worktreePath, branch, summary, result);
  }

  private finishBlocked(project: ProjectConfig, issue: ReadyIssue, reason: string, summary?: string): Promise<void> {
    return finishBlocked(this.ctx, project, issue, reason, summary);
  }

  private finishFailed(project: ProjectConfig, issue: ReadyIssue, error: string): Promise<void> {
    return finishFailed(this.ctx, project, issue, error);
  }

  private resetForFreshClaim(project: ProjectConfig, issueNumber: number): Promise<void> {
    return resetForFreshClaim(this.ctx, project, issueNumber);
  }

  private cleanupFinished(project: ProjectConfig, openIssues: { number: number }[]): Promise<void> {
    return cleanupFinished(this.ctx, project, openIssues);
  }
}
