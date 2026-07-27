import { EventEmitter } from "node:events";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import {
  ELEVATE_LABEL,
  FLEET_LABELS,
  LIGHT_LABEL,
  PLAN_LABEL,
  mergeModelUsage,
  type BoardTicket,
  type ClosedTicketRecord,
  type FleetConfig,
  type ModelUsageSummary,
  type PlanResult,
  type ProjectConfig,
  type TicketRecord,
} from "@fleet/shared";
import type { ApprovalManager } from "./approvals.ts";
import { run } from "./exec.ts";
import {
  buildReviewFeedbackPrompt,
  createIssue,
  createPullRequest,
  dependencyStatus,
  escalateToElevated,
  getIssueComments,
  getIssueLabels,
  getPrFeedback,
  getPrState,
  listFleetIssues,
  listIssueStates,
  markReady,
  parseDependsOn,
  swapLabel,
  toBoardTicket,
  upsertStatusComment,
  type PrFeedback,
  type ReadyIssue,
} from "./github.ts";
import { Journal } from "./journal.ts";
import { log, logError } from "./log.ts";
import { HistoryStore, StateStore } from "./state.ts";
import { TrailingThrottle } from "./throttle.ts";
import { WorkerSession, buildIssuePrompt, type SessionKind } from "./worker.ts";
import { createWorktree, hasCommits, pushBranch, removeWorktree, type Worktree } from "./worktree.ts";

const PR_FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

const STALL_NUDGE = [
  "Your session was interrupted.",
  "Inspect the current state of the worktree (git status, git log) to see what has already been done, then continue the ticket.",
  "If you had already finished, produce your final structured result again.",
].join(" ");

/** How long a restart waits for an aborted run to unwind before resetting anyway. */
const ABORT_DRAIN_MS = 30_000;

/** Resolves when `promise` settles or `ms` elapses — whichever is first, never rejecting. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
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

const RESTART_SUMMARY =
  "Restarted from the dashboard — a fresh session will pick this up. The previous session was terminated and its branch and worktree will be recreated from scratch.";

/** Cost and per-model usage a ticket had accrued before the current session started. */
interface SessionBase {
  costUsd: number;
  modelUsage?: Record<string, ModelUsageSummary>;
}

/**
 * Stalled tickets that should be auto-resumed for `project`: they have a session
 * to resume, are not already in flight, and have not been auto-resumed before
 * (a second stall is left for a human). Capped by the project's `maxConcurrent`,
 * counting tickets already running.
 */
export function pickAutoResumable(
  records: TicketRecord[],
  project: { name: string; maxConcurrent: number },
  runningKeys: Iterable<string>,
): TicketRecord[] {
  const running = new Set(runningKeys);
  const active = [...running].filter((k) => k.startsWith(`${project.name}#`)).length;
  const capacity = project.maxConcurrent - active;
  if (capacity <= 0) return [];
  return records
    .filter(
      (record) =>
        record.project === project.name &&
        record.status === "stalled" &&
        !!record.sessionId &&
        !record.autoResumed &&
        !running.has(`${record.project}#${record.issueNumber}`),
    )
    .slice(0, capacity);
}

/**
 * Which model a ticket's session should run on. `fleet:elevate` wins over
 * `fleet:light` when both are present — elevation is an escalation signal.
 * Either label falls through to the project default when its matching tier
 * model isn't configured.
 */
export function selectModel(
  project: { model?: string; elevatedModel?: string; lightModel?: string },
  opts: { elevated: boolean; light: boolean },
): string | undefined {
  if (opts.elevated) return project.elevatedModel ?? project.model;
  if (opts.light) return project.lightModel ?? project.model;
  return project.model;
}

/**
 * Whether a failed run should be auto-escalated to the elevated model instead of
 * parking the ticket in `fleet:needs-input`: the project must have an elevated
 * model configured, opt in (default), and this must be the ticket's first
 * failure at any tier — a manually- or already auto-elevated run that fails
 * again gets the normal needs-input treatment so escalation only ever fires once.
 */
export function shouldAutoElevate(
  project: { elevatedModel?: string; autoElevateOnFailure?: boolean },
  record: { elevated?: boolean; autoElevated?: boolean } | undefined,
): boolean {
  if (!project.elevatedModel) return false;
  if (project.autoElevateOnFailure === false) return false;
  if (record?.elevated) return false;
  if (record?.autoElevated) return false;
  return true;
}

/**
 * Ticket records eligible for PR-review-feedback resumption this cycle: sitting
 * in `review` with a PR and a resumable session, not already in flight, their
 * issue still open, and the project hasn't opted out.
 */
export function pickReviewCandidates(
  records: TicketRecord[],
  project: { name: string; autoAddressReviews?: boolean },
  openIssueNumbers: ReadonlySet<number>,
  runningKeys: Iterable<string>,
): TicketRecord[] {
  if (project.autoAddressReviews === false) return [];
  const running = new Set(runningKeys);
  return records.filter(
    (record) =>
      record.project === project.name &&
      record.status === "review" &&
      !!record.prUrl &&
      !!record.sessionId &&
      openIssueNumbers.has(record.issueNumber) &&
      !running.has(`${record.project}#${record.issueNumber}`),
  );
}

/** Approved-with-no-comment reviews (and no fresh inline comments) trigger nothing. */
export function shouldActOnFeedback(feedback: Pick<PrFeedback, "hasChangesRequested" | "reviews" | "comments">): boolean {
  return feedback.hasChangesRequested || feedback.reviews.length > 0 || feedback.comments.length > 0;
}

/**
 * The `fleet:ready` issues that are actually claimable this cycle: not already
 * in flight, and with every `Depends-on` reference satisfied (closed, or
 * pointing at an issue number this repo has never had). Preserves the input
 * order, which callers sort by priority-then-number before this filter runs.
 */
export function selectEligibleReady(
  issues: ReadyIssue[],
  opts: {
    openIssueNumbers: ReadonlySet<number>;
    allIssueNumbers: ReadonlySet<number>;
    isRunning: (issueNumber: number) => boolean;
  },
): ReadyIssue[] {
  return issues.filter((issue) => {
    if (!issue.labels.includes(FLEET_LABELS.ready)) return false;
    if (opts.isRunning(issue.number)) return false;
    const { blockedBy } = dependencyStatus(parseDependsOn(issue.body), opts.openIssueNumbers, opts.allIssueNumbers);
    return blockedBy.length === 0;
  });
}

/**
 * Synthesizes Done-column board tickets from archived history: the most
 * recently closed tickets overall (newest first), capped at `limit`. The
 * project filter on the dashboard narrows this further client-side, so no
 * per-project limit is applied here.
 */
export function synthesizeDoneTickets(
  history: ClosedTicketRecord[],
  projects: { name: string; githubRepo: string }[],
  limit = 5,
): BoardTicket[] {
  return [...history]
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
    .slice(0, limit)
    .map((record) => {
      const project = projects.find((p) => p.name === record.project);
      return {
        project: record.project,
        issueNumber: record.issueNumber,
        title: record.issueTitle,
        url: project ? `https://github.com/${project.githubRepo}/issues/${record.issueNumber}` : "",
        status: "done" as const,
        priority: null,
        isPlan: record.isPlan ?? false,
        record,
      };
    });
}

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
  readonly events = new EventEmitter();

  constructor(
    private readonly config: FleetConfig,
    private readonly state: StateStore,
    private readonly dataDirPath: string,
    private readonly approvals: ApprovalManager,
    private readonly dryRun: boolean,
  ) {
    this.history = new HistoryStore(dataDirPath);
  }

  private key(projectName: string, issueNumber: number): string {
    return `${projectName}#${issueNumber}`;
  }

  async cycle(): Promise<void> {
    this.flagStalled();
    this.updatePauseState();
    const paused = this.isPaused();
    if (!paused) this.recoverStalled();
    for (const project of this.config.projects) {
      try {
        await this.cycleProject(project, paused);
      } catch (err) {
        logError("loop", `polling ${project.name} failed`, err);
      }
    }
  }

  /** True while a plan usage-limit pause is in effect; board polling and cleanup still run, claims and resumes do not. */
  private isPaused(): boolean {
    const pausedUntil = this.state.getPausedUntil();
    return !!pausedUntil && Date.now() < Date.parse(pausedUntil);
  }

  /** Clears an expired pause; called once at the top of every cycle before anything checks `isPaused`. */
  private updatePauseState(): void {
    const pausedUntil = this.state.getPausedUntil();
    if (pausedUntil && Date.now() >= Date.parse(pausedUntil)) {
      this.state.setPausedUntil(undefined);
      log("loop", `plan usage-limit pause lifted (was paused until ${pausedUntil})`);
      this.emitBoard();
    }
  }

  private async cycleProject(project: ProjectConfig, paused: boolean): Promise<void> {
    const issues = await listFleetIssues(project);
    const { open: openIssueNumbers, all: allIssueNumbers } = await listIssueStates(project);

    const blockedByIssue = new Map<number, number[]>();
    for (const issue of issues) {
      const { blockedBy, unknown } = dependencyStatus(parseDependsOn(issue.body), openIssueNumbers, allIssueNumbers);
      for (const n of unknown) {
        log("loop", `${project.name}#${issue.number}: Depends-on references #${n}, which doesn't exist in this repo — treating as satisfied`);
      }
      blockedByIssue.set(issue.number, blockedBy);
    }

    this.boardCache.set(
      project.name,
      issues
        .map((issue) => toBoardTicket(project, issue, blockedByIssue.get(issue.number)))
        .filter((t): t is BoardTicket => t !== null),
    );
    this.emitBoard();

    if (this.dryRun) {
      log("loop", `[dry-run] would clean up finished tickets for ${project.name}`);
    } else {
      await this.cleanupFinished(project, issues);
    }

    if (paused) return;

    if (this.dryRun) {
      log("loop", `[dry-run] would check ${project.name} for PR review feedback to address`);
    } else {
      await this.addressReviews(project, openIssueNumbers);
    }

    const activeCount = [...this.running.keys()].filter((k) => k.startsWith(`${project.name}#`)).length;
    const capacity = project.maxConcurrent - activeCount;
    if (capacity <= 0) return;

    const ready = selectEligibleReady(issues, {
      openIssueNumbers,
      allIssueNumbers,
      isRunning: (issueNumber) => this.running.has(this.key(project.name, issueNumber)),
    });

    for (const issue of ready.slice(0, Math.max(0, capacity))) {
      if (this.dryRun) {
        log("loop", `[dry-run] would claim ${project.name}#${issue.number}: ${issue.title}`);
        continue;
      }
      this.track(project.name, issue.number, this.processTicket(project, issue));
    }
  }

  private track(projectName: string, issueNumber: number, promise: Promise<void>): void {
    const key = this.key(projectName, issueNumber);
    this.running.set(key, promise.finally(() => this.running.delete(key)));
  }

  private async processTicket(project: ProjectConfig, issue: ReadyIssue): Promise<void> {
    const now = new Date().toISOString();
    const scope = this.key(project.name, issue.number);
    log("loop", `claiming ${scope}: ${issue.title}`);

    try {
      await swapLabel(project, issue.number, FLEET_LABELS.ready, FLEET_LABELS.inProgress);
      const comments = await getIssueComments(project, issue.number);
      const worktree = await createWorktree(project, issue.number, this.config.worktreeRoot);

      const elevated = issue.labels.includes(ELEVATE_LABEL);
      const light = issue.labels.includes(LIGHT_LABEL);
      const isPlan = issue.labels.includes(PLAN_LABEL);
      // A fresh claim otherwise wipes the once-only escalation guard along with
      // everything else the prior attempt recorded — carry it forward so a
      // second failure (now elevated) can't trigger a second auto-escalation.
      const autoElevated = this.state.get(project.name, issue.number)?.autoElevated ?? false;
      this.state.upsert({
        project: project.name,
        issueNumber: issue.number,
        issueTitle: issue.title,
        branch: worktree.branch,
        worktreePath: worktree.path,
        status: "running",
        startedAt: now,
        lastActivityAt: now,
        costUsd: 0,
        elevated,
        light,
        isPlan,
        autoElevated,
      });

      const journal = new Journal(this.dataDirPath, project.name, issue.number);
      journal.append({ type: "fleet", event: "claimed", issue: issue.number, title: issue.title, elevated, light, isPlan });

      await this.runSession(
        project,
        issue,
        worktree,
        journal,
        undefined,
        buildIssuePrompt(project, issue, comments),
        elevated,
        light,
        isPlan ? "plan" : "code",
      );
    } catch (err) {
      logError("loop", `${scope} failed`, err);
      try {
        await this.finishFailed(project, issue, err instanceof Error ? err.message : String(err));
      } catch (reportErr) {
        logError("loop", `${scope}: could not report failure to GitHub`, reportErr);
      }
    }
  }

  private async runSession(
    project: ProjectConfig,
    issue: ReadyIssue,
    worktree: Worktree,
    journal: Journal,
    resumeSessionId: string | undefined,
    firstMessage: string,
    elevated: boolean,
    light: boolean,
    kind: SessionKind,
  ): Promise<void> {
    const key = this.key(project.name, issue.number);
    const existing = this.state.get(project.name, issue.number);
    // `total_cost_usd`/`modelUsage` restart at zero for every resumed session, so
    // remember what the ticket had already spent and add to it.
    const base: SessionBase = { costUsd: existing?.costUsd ?? 0, modelUsage: existing?.modelUsage };
    const model = selectModel(project, { elevated, light });
    if (elevated && light) {
      log("loop", `${key}: both ${ELEVATE_LABEL} and ${LIGHT_LABEL} are present — elevate wins`);
    }
    if (elevated && project.elevatedModel) {
      log("loop", `${key}: running elevated on ${project.elevatedModel}`);
    } else if (!elevated && light && project.lightModel) {
      log("loop", `${key}: running light on ${project.lightModel}`);
    }
    const session = new WorkerSession({
      project,
      scope: key,
      worktreePath: worktree.path,
      journal,
      model,
      kind,
      onActivity: (note) => {
        const record = this.state.get(project.name, issue.number);
        this.state.update(project.name, issue.number, {
          lastActivityAt: new Date().toISOString(),
          ...(note ? { lastActivityNote: note } : {}),
          ...(record?.status === "stalled" ? { status: "running" as const } : {}),
        });
        this.emitBoard();
      },
      canUseTool: this.makeCanUseTool(project, issue.number),
      claudeExecutable: this.config.claudeExecutable,
      resumeSessionId,
    });
    this.live.set(key, session);
    this.state.update(project.name, issue.number, { sessionLive: true });
    try {
      session.send(firstMessage);
      await this.supervise(project, issue, worktree, session, base);
    } finally {
      this.live.delete(key);
      this.replyWaiters.delete(key);
      session.close();
      this.state.update(project.name, issue.number, {
        sessionLive: false,
        sessionId: session.sessionId,
        costUsd: base.costUsd + session.costUsd,
        modelUsage: mergeModelUsage(base.modelUsage, session.modelUsage),
      });
      this.emitBoard();
    }
  }

  private async supervise(
    project: ProjectConfig,
    issue: ReadyIssue,
    worktree: Worktree,
    session: WorkerSession,
    base: SessionBase,
  ): Promise<void> {
    const key = this.key(project.name, issue.number);
    for (;;) {
      const turn = await session.nextResult(this.config.ticketTimeoutMinutes * 60_000);
      this.state.update(project.name, issue.number, {
        sessionId: session.sessionId,
        costUsd: base.costUsd + session.costUsd,
        model: session.model,
        modelUsage: mergeModelUsage(base.modelUsage, session.modelUsage),
      });

      if (turn.errorSubtype === "plan_limit") {
        await this.handlePlanLimit(project, issue, turn.limitResetAt);
        return;
      }

      if (turn.kind === "plan") {
        if (turn.result?.status === "completed") {
          await this.finishPlanned(project, issue, turn.result);
          return;
        }
        if (turn.result?.status === "blocked") {
          await this.finishBlocked(
            project,
            issue,
            turn.result.blockedReason ?? "Planner reported blocked without a reason.",
            turn.result.summary,
          );
          const reply = await this.waitForReply(key, this.config.replyWaitMinutes * 60_000);
          if (reply === undefined) {
            log("loop", `${key}: no reply within ${this.config.replyWaitMinutes}m — session closed, resumable from the dashboard`);
            return;
          }
          await this.markWorking(project, issue.number);
          session.send(reply);
          continue;
        }
        await this.finishFailed(project, issue, turn.errorSubtype ?? "unknown error");
        return;
      }

      if (turn.result?.status === "completed") {
        await this.finishCompleted(project, issue, worktree.path, worktree.branch, turn.result.summary, turn.result);
        return;
      }
      if (turn.result?.status === "blocked") {
        await this.finishBlocked(
          project,
          issue,
          turn.result.blockedReason ?? "Worker reported blocked without a reason.",
          turn.result.summary,
        );
        const reply = await this.waitForReply(key, this.config.replyWaitMinutes * 60_000);
        if (reply === undefined) {
          log("loop", `${key}: no reply within ${this.config.replyWaitMinutes}m — session closed, resumable from the dashboard`);
          return;
        }
        await this.markWorking(project, issue.number);
        session.send(reply);
        continue;
      }
      await this.finishFailed(project, issue, turn.errorSubtype ?? "unknown error");
      return;
    }
  }

  private waitForReply(key: string, timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.replyWaiters.delete(key);
        resolve(undefined);
      }, timeoutMs);
      this.replyWaiters.set(key, (message) => {
        clearTimeout(timer);
        this.replyWaiters.delete(key);
        resolve(message);
      });
    });
  }

  async reply(projectName: string, issueNumber: number, message: string): Promise<"steered" | "resumed"> {
    const key = this.key(projectName, issueNumber);
    // A human-driven session earns a fresh auto-recovery if it stalls.
    this.state.update(projectName, issueNumber, { autoResumed: false });

    const waiter = this.replyWaiters.get(key);
    if (waiter) {
      waiter(message);
      return "steered";
    }

    const liveSession = this.live.get(key);
    if (liveSession) {
      liveSession.send(message);
      log("loop", `${key}: reply queued into running session`);
      return "steered";
    }

    const record = this.state.get(projectName, issueNumber);
    const project = this.getProject(projectName);
    if (!project) throw new Error(`unknown project ${projectName}`);
    if (!record?.sessionId) throw new Error(`no session recorded for ${key}; label the issue fleet:ready to start fresh`);
    if (this.running.has(key)) throw new Error(`${key} is mid-transition; try again shortly`);

    this.track(projectName, issueNumber, this.resumeTicket(project, record, message));
    return "resumed";
  }

  private async resumeTicket(project: ProjectConfig, record: TicketRecord, message: string): Promise<void> {
    const issue: ReadyIssue = { number: record.issueNumber, title: record.issueTitle, body: "", labels: [] };
    const scope = this.key(project.name, record.issueNumber);
    log("loop", `${scope}: resuming session ${record.sessionId}`);
    try {
      let elevated = record.elevated ?? false;
      let light = record.light ?? false;
      let isPlan = record.isPlan ?? false;
      try {
        const labels = await getIssueLabels(project, record.issueNumber);
        elevated = labels.includes(ELEVATE_LABEL);
        light = labels.includes(LIGHT_LABEL);
        isPlan = labels.includes(PLAN_LABEL);
      } catch {
        // label check is best-effort; fall back to the recorded flags
      }
      this.state.update(project.name, record.issueNumber, { elevated, light, isPlan });
      await this.markWorking(project, record.issueNumber);
      const journal = new Journal(this.dataDirPath, project.name, record.issueNumber);
      journal.append({ type: "fleet", event: "resumed", sessionId: record.sessionId, elevated, light, isPlan });
      await this.runSession(
        project,
        issue,
        { path: record.worktreePath, branch: record.branch },
        journal,
        record.sessionId,
        message,
        elevated,
        light,
        isPlan ? "plan" : "code",
      );
    } catch (err) {
      logError("loop", `${scope} resume failed`, err);
      try {
        await this.finishFailed(project, issue, err instanceof Error ? err.message : String(err));
      } catch (reportErr) {
        logError("loop", `${scope}: could not report failure to GitHub`, reportErr);
      }
    }
  }

  /**
   * Force-close a ticket's session and put the issue back in `fleet:ready` so the
   * next poll cycle claims it from scratch. `processTicket` → `createWorktree`
   * force-removes the worktree and recreates the branch from
   * `origin/<defaultBranch>`, so a restart **discards the previous session's
   * commits** — that is the point, and the dashboard says so before firing.
   *
   * The claim is deliberately left to the normal loop rather than done here, so
   * restarts obey `maxConcurrent` like any other pickup.
   */
  async restartTicket(projectName: string, issueNumber: number): Promise<void> {
    const key = this.key(projectName, issueNumber);
    const project = this.getProject(projectName);
    if (!project) throw new Error(`unknown project ${projectName}`);
    if (this.restarting.has(key)) throw new Error(`${key} is already restarting`);

    const session = this.live.get(key);
    const inFlight = this.running.get(key);
    // In flight with no session to abort means the ticket is between phases
    // (claiming, opening a PR, tearing a session down) where interrupting would
    // leave GitHub and the worktree disagreeing. Same guard as `reply`.
    if (!session && inFlight) throw new Error(`${key} is mid-transition; try again shortly`);

    if (session) {
      // The flag must be set before the abort: aborting surfaces to `supervise`
      // as an errored turn, and `finishFailed` has to know not to report it.
      this.restarting.add(key);
      this.state.update(projectName, issueNumber, { status: "restarting", lastSummary: RESTART_SUMMARY });
      this.emitBoard();
      log("loop", `${key}: restart requested — aborting session ${session.sessionId ?? "(not yet started)"}`);
      session.abortController.abort();
      // A session parked after reporting `blocked` is waiting on a reply, not on
      // the SDK, so it would ignore the abort for the rest of `replyWaitMinutes`.
      // Release the park so `supervise` returns now.
      this.replyWaiters.get(key)?.(undefined);
      // The flag is cleared when the run actually settles, however long that
      // takes — a wedged session that errors out much later must still not report
      // a failure over the reset. The reset itself waits only `ABORT_DRAIN_MS` so
      // the dashboard always gets an answer; `running` still holds the key
      // meanwhile, so no fresh claim can start until the old run is truly gone.
      const clear = () => void this.restarting.delete(key);
      const drained = (inFlight ?? Promise.resolve()).then(clear, clear);
      // Wait for the run to unwind so its teardown (state writes, session close)
      // lands before the reset below overwrites the record.
      await settleWithin(drained, ABORT_DRAIN_MS);
      if (this.restarting.has(key)) {
        log("loop", `${key}: session did not unwind within ${ABORT_DRAIN_MS / 1000}s — resetting to ready anyway`);
      }
    }

    await this.resetForFreshClaim(project, issueNumber);
  }

  /**
   * Drop everything that would make the next cycle resume rather than restart:
   * the recorded session id, the live flag, and the once-only auto-resume budget.
   * The journal file is kept — only an entry is appended — so the restarted
   * ticket's history stays readable in the dashboard.
   */
  private async resetForFreshClaim(project: ProjectConfig, issueNumber: number): Promise<void> {
    const key = this.key(project.name, issueNumber);
    new Journal(this.dataDirPath, project.name, issueNumber).append({
      type: "fleet",
      event: "restarted-by-operator",
    });
    this.state.update(project.name, issueNumber, {
      status: "restarting",
      sessionId: undefined,
      sessionLive: false,
      autoResumed: false,
      lastSummary: RESTART_SUMMARY,
      lastActivityAt: new Date().toISOString(),
      lastActivityNote: undefined,
    });
    // Label last: from here the ticket is claimable, so nothing after this may
    // write to the state record.
    await markReady(project, issueNumber);
    this.emitBoard();
    log("loop", `${key}: reset to ${FLEET_LABELS.ready} for a fresh session`);
    // Best-effort: the ticket is already restarted, so a failed comment is worth
    // logging but not worth reporting back as a failed restart.
    try {
      await upsertStatusComment(project, issueNumber, [`**Status: restarting**`, RESTART_SUMMARY].join("\n\n"));
    } catch (err) {
      logError("loop", `${key}: could not post the restart status comment`, err);
    }
  }

  private async markWorking(project: ProjectConfig, issueNumber: number): Promise<void> {
    try {
      await swapLabel(project, issueNumber, FLEET_LABELS.needsInput, FLEET_LABELS.inProgress);
    } catch (err) {
      logError("loop", `${this.key(project.name, issueNumber)}: label swap to in-progress failed`, err);
    }
    // Stamp activity too: a resumed ticket whose last activity is already past the
    // stall cutoff would otherwise be re-flagged as stalled before its first message.
    this.state.update(project.name, issueNumber, { status: "running", lastActivityAt: new Date().toISOString() });
    this.emitBoard();
  }

  private makeCanUseTool(project: ProjectConfig, issueNumber: number): CanUseTool {
    return async (toolName, input, { signal }) => {
      const kind = toolName === "AskUserQuestion" ? "question" : "permission";
      const outcome = await this.approvals.request({
        project: project.name,
        issueNumber,
        toolName,
        kind,
        input,
        timeoutMs: this.config.approvalTimeoutMinutes * 60_000,
        signal,
      });
      if (kind === "question") {
        if (outcome.message) {
          return { behavior: "deny", message: `The user answered your questions:\n\n${outcome.message}\n\nIncorporate these answers and continue.` };
        }
        return {
          behavior: "deny",
          message: `No answer arrived within ${this.config.approvalTimeoutMinutes} minutes. Finish with status "blocked" and restate your questions in blockedReason.`,
        };
      }
      if (outcome.allowed) return { behavior: "allow", updatedInput: input };
      return {
        behavior: "deny",
        message: outcome.message ?? `Denied via fleet dashboard (or approval timed out after ${this.config.approvalTimeoutMinutes} minutes). Find another way, or finish with status "blocked" explaining what you need.`,
      };
    };
  }

  private async finishCompleted(
    project: ProjectConfig,
    issue: ReadyIssue,
    worktreePath: string,
    branch: string,
    summary: string,
    result: { prTitle?: string; prBody?: string; filesChanged: string[]; confidence: string },
  ): Promise<void> {
    if (!(await hasCommits(project, worktreePath))) {
      await this.finishBlocked(project, issue, "Worker reported completed but made no commits.", summary);
      return;
    }
    await pushBranch(project, worktreePath, branch);
    const prBody = [
      result.prBody ?? summary,
      `Closes #${issue.number}`,
      PR_FOOTER,
    ].join("\n\n");
    const record = this.state.get(project.name, issue.number);
    let prUrl = record?.prUrl;
    if (!prUrl) {
      prUrl = await createPullRequest(project, branch, result.prTitle ?? issue.title, prBody);
    }
    await upsertStatusComment(
      project,
      issue.number,
      [
        `**Status: ready for review** (confidence: ${result.confidence})`,
        summary,
        result.filesChanged.length > 0 ? `Files changed:\n${result.filesChanged.map((f) => `- \`${f}\``).join("\n")}` : "",
        prUrl ? `PR: ${prUrl}` : "",
      ].filter(Boolean).join("\n\n"),
    );
    await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.review);
    this.state.update(project.name, issue.number, { status: "review", prUrl, lastSummary: summary });
    this.emitBoard();
    log("loop", `${project.name}#${issue.number}: PR ${prUrl}`);
  }

  /**
   * A completed plan never pushes or opens a PR — it files child issues instead,
   * `fleet:ready` only when the project opts in via `planChildrenReady`, and puts
   * the epic itself straight into `fleet:review` for a human to curate.
   */
  private async finishPlanned(project: ProjectConfig, issue: ReadyIssue, result: PlanResult): Promise<void> {
    const autoReady = project.planChildrenReady;
    const created: { number: number; url: string; title: string }[] = [];
    for (const ticket of result.tickets) {
      const tierLabel = ticket.tier === "light" ? LIGHT_LABEL : ticket.tier === "elevated" ? ELEVATE_LABEL : undefined;
      const labels = [
        ...(ticket.priority ? [ticket.priority] : []),
        ...(tierLabel ? [tierLabel] : []),
        ...(autoReady ? [FLEET_LABELS.ready] : []),
      ];
      const child = await createIssue(project, { title: ticket.title, body: ticket.body, labels });
      created.push({ ...child, title: ticket.title });
    }
    await upsertStatusComment(
      project,
      issue.number,
      [
        `**Status: planned** (confidence: ${result.confidence})`,
        result.summary,
        created.length > 0
          ? `Child tickets:\n${created.map((c) => `- #${c.number} ${c.title} — ${c.url}`).join("\n")}`
          : "No child tickets were proposed.",
        autoReady ? "" : "Label a child `fleet:ready` to start it.",
      ].filter(Boolean).join("\n\n"),
    );
    await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.review);
    this.state.update(project.name, issue.number, { status: "review", lastSummary: result.summary });
    this.emitBoard();
    log("loop", `${project.name}#${issue.number}: planned ${created.length} child ticket(s)`);
  }

  /**
   * A plan usage-limit hit isn't the ticket's fault and isn't retryable right now: every
   * session across every project would fail the same way until the plan's window resets.
   * Rather than failing the ticket, pause the whole daemon and leave this ticket `stalled`
   * with its session id intact so `recoverStalled` resumes it automatically once the pause
   * lifts — clearing `autoResumed` so the once-only stall guard doesn't swallow that resume.
   */
  private async handlePlanLimit(project: ProjectConfig, issue: ReadyIssue, limitResetAt: string | undefined): Promise<void> {
    const key = this.key(project.name, issue.number);
    const resetAt = limitResetAt ? new Date(limitResetAt) : new Date(Date.now() + this.config.limitDefaultBackoffMinutes * 60_000);
    const pausedUntil = new Date(resetAt.getTime() + this.config.limitResumeSlackMinutes * 60_000);

    const existing = this.state.getPausedUntil();
    if (!existing || pausedUntil.getTime() > Date.parse(existing)) {
      this.state.setPausedUntil(pausedUntil.toISOString());
      log("loop", `${key}: plan usage limit hit — pausing daemon until ${pausedUntil.toISOString()}`);
    } else {
      log("loop", `${key}: plan usage limit hit again — existing pause until ${existing} already covers it`);
    }

    this.state.update(project.name, issue.number, {
      status: "stalled",
      lastActivityNote: `paused: plan limit until ${pausedUntil.toLocaleString()}`,
      autoResumed: false,
    });
    this.emitBoard();

    try {
      await upsertStatusComment(
        project,
        issue.number,
        [`**Status: paused**`, `Plan usage limit reached — resuming automatically ~${pausedUntil.toLocaleString()}.`].join("\n\n"),
      );
    } catch (err) {
      logError("loop", `${key}: could not post the plan-limit pause status comment`, err);
    }
  }

  private async finishBlocked(project: ProjectConfig, issue: ReadyIssue, reason: string, summary?: string): Promise<void> {
    await upsertStatusComment(
      project,
      issue.number,
      [`**Status: needs input**`, summary ?? "", `Blocked on: ${reason}`, "Reply from the fleet dashboard to continue."].filter(Boolean).join("\n\n"),
    );
    await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput);
    this.state.update(project.name, issue.number, { status: "needs-input", lastSummary: reason });
    this.emitBoard();
    log("loop", `${project.name}#${issue.number}: needs input — ${reason}`);
  }

  /**
   * An operator restart aborts the session, which reaches `supervise` (or the
   * `processTicket`/`resumeTicket` catch blocks) as an ordinary errored turn.
   * Reporting that would post a "failed" comment and swap the issue to
   * `fleet:needs-input`, fighting the reset `restartTicket` is about to do — so
   * a restarting key is logged and dropped instead. Guarding here rather than at
   * the call sites means no failure path can leak past it.
   */
  private async finishFailed(project: ProjectConfig, issue: ReadyIssue, error: string): Promise<void> {
    const key = this.key(project.name, issue.number);
    if (this.restarting.has(key)) {
      log("loop", `${key}: run ended during an operator restart (${error}) — not reporting it as a failure`);
      return;
    }

    const record = this.state.get(project.name, issue.number);
    if (shouldAutoElevate(project, record)) {
      await upsertStatusComment(
        project,
        issue.number,
        [
          `**Status: failed**`,
          `The worker run failed: ${error}`,
          `Retrying automatically on the elevated model (\`${project.elevatedModel}\`).`,
        ].join("\n\n"),
      );
      await escalateToElevated(project, issue.number);
      this.state.update(project.name, issue.number, { status: "failed", lastSummary: error, autoElevated: true });
      this.emitBoard();
      log("loop", `${key}: failed — auto-escalating to ${project.elevatedModel} (once)`);
      return;
    }

    await upsertStatusComment(
      project,
      issue.number,
      [`**Status: failed**`, `The worker run failed: ${error}`, "Re-label with `fleet:ready` to retry, or reply from the dashboard to resume."].join("\n\n"),
    );
    await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput);
    this.state.update(project.name, issue.number, { status: "failed", lastSummary: error });
    this.emitBoard();
  }

  /**
   * Changes-requested reviews (or fresh inline comments) on an open fleet PR
   * resume that ticket's session in its existing worktree/branch. Runs before
   * claiming new `fleet:ready` issues so in-flight work gets capacity first;
   * the per-candidate active-count check below is what makes it count against
   * `maxConcurrent` rather than bypassing it.
   */
  private async addressReviews(project: ProjectConfig, openIssueNumbers: ReadonlySet<number>): Promise<void> {
    const candidates = pickReviewCandidates(this.state.all(), project, openIssueNumbers, this.running.keys());

    for (const record of candidates) {
      const activeCount = [...this.running.keys()].filter((k) => k.startsWith(`${project.name}#`)).length;
      if (activeCount >= project.maxConcurrent) return;

      const scope = this.key(project.name, record.issueNumber);
      let feedback: PrFeedback;
      try {
        feedback = await getPrFeedback(project, record.prUrl as string, record.lastReviewHandledAt);
      } catch (err) {
        logError("loop", `${scope}: could not fetch PR review feedback`, err);
        continue;
      }
      if (!shouldActOnFeedback(feedback) || !feedback.latestAt) continue;

      // Watermark set before resuming so a crash can't reprocess the same feedback.
      this.state.update(project.name, record.issueNumber, { lastReviewHandledAt: feedback.latestAt });
      await swapLabel(project, record.issueNumber, FLEET_LABELS.review, FLEET_LABELS.inProgress);
      log("loop", `${scope}: PR review feedback arrived — resuming session ${record.sessionId}`);
      this.track(project.name, record.issueNumber, this.resumeTicket(project, record, buildReviewFeedbackPrompt(feedback)));
    }
  }

  private async cleanupFinished(project: ProjectConfig, openIssues: { number: number }[]): Promise<void> {
    const openNumbers = new Set(openIssues.map((i) => i.number));
    for (const record of this.state.all()) {
      if (record.project !== project.name) continue;
      if (record.status !== "review" || !record.prUrl) continue;
      if (openNumbers.has(record.issueNumber)) continue;
      if (this.running.has(this.key(record.project, record.issueNumber))) continue;

      let rawPrState: string;
      try {
        rawPrState = await getPrState(project, record.prUrl);
      } catch (err) {
        logError("loop", `${record.project}#${record.issueNumber}: could not check PR state`, err);
        continue;
      }
      if (rawPrState !== "MERGED" && rawPrState !== "CLOSED") continue;
      const prState: "MERGED" | "CLOSED" = rawPrState;

      log("loop", `${record.project}#${record.issueNumber}: PR ${prState.toLowerCase()} and issue closed — cleaning up worktree + branch ${record.branch}`);
      await removeWorktree(project, record.worktreePath);
      await run("git", ["-C", project.repoPath, "branch", "-D", record.branch], { allowFailure: true });
      this.history.add({ ...record, closedAt: new Date().toISOString(), prState });
      this.state.remove(record.project, record.issueNumber);
      this.emitBoard();
    }
  }

  /**
   * Resume stalled tickets that still have a session, once each. Covers both boot
   * reconciliation (`clearLiveFlags` turns orphaned `running` tickets into
   * `stalled`) and mid-run stalls flagged by `flagStalled`.
   */
  private recoverStalled(): void {
    for (const project of this.config.projects) {
      for (const record of pickAutoResumable(this.state.all(), project, this.running.keys())) {
        const scope = this.key(record.project, record.issueNumber);
        if (this.dryRun) {
          log("loop", `[dry-run] would auto-resume stalled ${scope} from session ${record.sessionId}`);
          continue;
        }
        log("loop", `${scope}: stalled — auto-resuming session ${record.sessionId} (once)`);
        const updated = this.state.update(record.project, record.issueNumber, { autoResumed: true }) ?? record;
        this.track(record.project, record.issueNumber, this.resumeTicket(project, updated, STALL_NUDGE));
      }
    }
  }

  private flagStalled(): void {
    const cutoff = Date.now() - this.config.stalledAfterMinutes * 60_000;
    for (const ticket of this.state.all()) {
      if (ticket.status === "running" && Date.parse(ticket.lastActivityAt) < cutoff) {
        this.state.update(ticket.project, ticket.issueNumber, { status: "stalled" });
        log("loop", `${ticket.project}#${ticket.issueNumber}: STALLED (no activity since ${ticket.lastActivityAt})`);
      }
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  get activeCount(): number {
    return this.running.size;
  }

  getBoard(): BoardTicket[] {
    const active = [...this.boardCache.values()].flat().map((t) => ({
      ...t,
      record: this.state.get(t.project, t.issueNumber),
    }));
    return [...active, ...synthesizeDoneTickets(this.history.all(), this.config.projects)];
  }

  getProject(name: string): ProjectConfig | undefined {
    return this.config.projects.find((p) => p.name === name);
  }

  private emitBoard(): void {
    this.boardThrottle.trigger();
  }
}
