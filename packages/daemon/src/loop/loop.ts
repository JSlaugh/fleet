import { EventEmitter } from "node:events";
import type {
  BoardTicket,
  BudgetStatus,
  ClosedTicketRecord,
  DigestResponse,
  FleetConfig,
  HistoryResponse,
  PlanResult,
  ProjectConfig,
  WorkHoursReserveStatus,
} from "@fleet/shared";
import type { ApprovalManager } from "../session/approvals.ts";
import { cleanupFinished, dormantProjectNames, getBoard, issueUrl, pausedProjectNames } from "./board.ts";
import { budgetStatus } from "./budget.ts";
import { cycleProject } from "./claim.ts";
import type { LoopContext, SessionBase } from "./context.ts";
import { checkDigestSchedule, getDigest } from "./digest.ts";
import { finishBlocked, finishCompleted, finishFailed } from "./finish.ts";
import { refreshOwnHeartbeats, refreshStalledHeartbeatsOnBoot } from "./heartbeat.ts";
import type { ReadyIssue } from "../github/github.ts";
import { type HistoryQuery, queryHistory } from "../store/history.ts";
import { logError } from "../log.ts";
import { acceptPlan, reply, resetForFreshClaim, restartTicket, ticketCapabilities } from "./operator.ts";
import { handlePlanLimit, isPaused, setPaused, setProjectPaused, updatePauseState } from "./pause.ts";
import { setProjectDormant } from "./pin.ts";
import { flagStalled, recoverStalled } from "./recovery.ts";
import { stopLiveSessions } from "./shutdown.ts";
import { recoverPendingTeardowns } from "./teardown.ts";
import { workHoursReserveStatus } from "./workHoursReserve.ts";
import { HistoryStore, StateStore } from "../store/state.ts";
import { machineReviewGate, planReviewGate } from "./supervise.ts";
import { TrailingThrottle } from "../throttle.ts";
import type { WorkerSession } from "../session/worker.ts";
import type { Worktree } from "../github/worktree.ts";

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
  /** Keys whose session a daemon stop-now is aborting; see `finishFailed`. */
  private readonly stopping = new Set<string>();
  /** Set by `beginShutdown`; guards `/api/daemon/shutdown` and SIGINT/SIGTERM against double-fire. */
  private shuttingDown = false;
  /** Resolvers for sessions parked after reporting `blocked`; `undefined` releases the park without a reply. */
  private readonly replyWaiters = new Map<string, (message: string | undefined) => void>();
  private readonly boardCache = new Map<string, BoardTicket[]>();
  /** `project#issue` keys already logged as skipped for a non-collaborator author — logged once per issue, not once per cycle. */
  private readonly contributorFloorSkipsLogged = new Set<string>();
  /** Project names currently notified about a budget-gate `blocked` hold; see `LoopContext`. */
  private readonly budgetBlockedNotified = new Set<string>();
  /** Project names currently logged for a work-hours reserve hold; see `LoopContext`. */
  private readonly workHoursReserveNotified = new Set<string>();
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
      stopping: this.stopping,
      replyWaiters: this.replyWaiters,
      boardCache: this.boardCache,
      contributorFloorSkipsLogged: this.contributorFloorSkipsLogged,
      budgetBlockedNotified: this.budgetBlockedNotified,
      workHoursReserveNotified: this.workHoursReserveNotified,
      emitBoard: () => this.boardThrottle.trigger(),
      getProject: (name) => this.getProject(name),
      isShuttingDown: () => this.shuttingDown,
    };
  }

  /** Boot-only: force-refresh the heartbeat on this daemon's own stalled tickets before the first cycle, so a quick restart's recovery window never looks stale to a peer. */
  async refreshBootHeartbeats(): Promise<void> {
    await refreshStalledHeartbeatsOnBoot(this.ctx);
  }

  /** Boot-only: run the pending teardown of any ticket whose worktree is already gone — the daemon died (or the directory was removed by hand) between worktree removal and teardown. */
  async recoverPendingTeardowns(): Promise<void> {
    await recoverPendingTeardowns(this.ctx);
  }

  async cycle(): Promise<void> {
    this.flagStalled();
    this.updatePauseState();
    this.recoverStalled();
    await refreshOwnHeartbeats(this.ctx);
    await checkDigestSchedule(this.ctx);
    for (const project of this.config.projects) {
      try {
        await cycleProject(this.ctx, project);
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

  async acceptPlan(projectName: string, issueNumber: number): Promise<void> {
    return acceptPlan(this.ctx, projectName, issueNumber);
  }

  ticketCapabilities(projectName: string, issueNumber: number, known: boolean): { canRestart: boolean; canReply: boolean } {
    return ticketCapabilities(this.ctx, projectName, issueNumber, known);
  }

  setPaused(paused: boolean): void {
    setPaused(this.ctx, paused);
  }

  setProjectPaused(projectName: string, paused: boolean): void {
    setProjectPaused(this.ctx, projectName, paused);
  }

  getPausedProjects(): string[] {
    return pausedProjectNames(this.ctx);
  }

  setProjectDormant(projectName: string, dormant: boolean): void {
    setProjectDormant(this.ctx, projectName, dormant);
  }

  getDormantProjects(): string[] {
    return dormantProjectNames(this.ctx);
  }

  getBudgetStatus(): BudgetStatus | undefined {
    return budgetStatus(this.ctx);
  }

  getWorkHoursReserveStatus(): WorkHoursReserveStatus | undefined {
    return workHoursReserveStatus(this.ctx);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  get activeCount(): number {
    return this.running.size;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Synchronous double-fire guard: only the first caller gets `true` back and
   * should go on to actually run `shutdownDrain`/`shutdownNow`. Split out from
   * those so a caller (the HTTP route, a signal handler) can respond
   * immediately — 409 or accepted — without waiting on the shutdown itself.
   */
  beginShutdown(): boolean {
    if (this.shuttingDown) return false;
    this.shuttingDown = true;
    return true;
  }

  /** Drain mode: stop claiming/resuming and resolve once every running ticket reaches a normal terminal state. */
  async shutdownDrain(): Promise<void> {
    this.setPaused(true);
    await this.drain();
  }

  /** Stop-now: abort every live session, leaving each interrupted ticket resumable on the next boot. */
  async shutdownNow(): Promise<void> {
    await stopLiveSessions(this.ctx);
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

  getHistoryPage(query: HistoryQuery = {}): HistoryResponse {
    const page = queryHistory(this.history.all(), query);
    return {
      ...page,
      records: page.records.map((record) => ({ ...record, url: issueUrl(this.config.projects, record) })),
    };
  }

  getDigest(hours: number): DigestResponse {
    return getDigest(this.ctx, hours);
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

  private planReviewGate(
    project: ProjectConfig,
    issue: ReadyIssue,
    worktree: Worktree,
    base: SessionBase,
    result: PlanResult,
  ): Promise<{ action: "proceed" } | { action: "fixing"; prompt: string }> {
    return planReviewGate(this.ctx, project, issue, worktree, base, result);
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

  private finishFailed(
    project: ProjectConfig,
    issue: ReadyIssue,
    error: string,
    opts?: { postCompletion?: boolean },
  ): Promise<void> {
    return finishFailed(this.ctx, project, issue, error, opts);
  }

  private resetForFreshClaim(project: ProjectConfig, issueNumber: number): Promise<void> {
    return resetForFreshClaim(this.ctx, project, issueNumber);
  }

  private cleanupFinished(project: ProjectConfig, openIssues: { number: number }[]): Promise<void> {
    return cleanupFinished(this.ctx, project, openIssues);
  }
}
