import { EventEmitter } from "node:events";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { FLEET_LABELS, type BoardTicket, type FleetConfig, type ProjectConfig, type TicketRecord } from "@fleet/shared";
import type { ApprovalManager } from "./approvals.ts";
import { run } from "./exec.ts";
import {
  createPullRequest,
  getIssueComments,
  getPrState,
  listFleetIssues,
  swapLabel,
  toBoardTicket,
  upsertStatusComment,
  type ReadyIssue,
} from "./github.ts";
import { Journal } from "./journal.ts";
import { log, logError } from "./log.ts";
import { StateStore } from "./state.ts";
import { WorkerSession, buildIssuePrompt } from "./worker.ts";
import { createWorktree, hasCommits, pushBranch, removeWorktree, type Worktree } from "./worktree.ts";

const PR_FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

export class FleetLoop {
  private readonly running = new Map<string, Promise<void>>();
  private readonly live = new Map<string, WorkerSession>();
  private readonly replyWaiters = new Map<string, (message: string) => void>();
  private readonly boardCache = new Map<string, BoardTicket[]>();
  private lastBoardEmit = 0;
  readonly events = new EventEmitter();

  constructor(
    private readonly config: FleetConfig,
    private readonly state: StateStore,
    private readonly dataDirPath: string,
    private readonly approvals: ApprovalManager,
    private readonly dryRun: boolean,
  ) {}

  private key(projectName: string, issueNumber: number): string {
    return `${projectName}#${issueNumber}`;
  }

  async cycle(): Promise<void> {
    this.flagStalled();
    for (const project of this.config.projects) {
      try {
        await this.cycleProject(project);
      } catch (err) {
        logError("loop", `polling ${project.name} failed`, err);
      }
    }
  }

  private async cycleProject(project: ProjectConfig): Promise<void> {
    const issues = await listFleetIssues(project);
    this.boardCache.set(
      project.name,
      issues
        .map((issue) => toBoardTicket(project, issue))
        .filter((t): t is BoardTicket => t !== null),
    );
    this.emitBoard();

    await this.cleanupFinished(project, issues);

    const activeCount = [...this.running.keys()].filter((k) => k.startsWith(`${project.name}#`)).length;
    const capacity = project.maxConcurrent - activeCount;
    if (capacity <= 0) return;

    const ready = issues.filter(
      (issue) =>
        issue.labels.includes(FLEET_LABELS.ready) && !this.running.has(this.key(project.name, issue.number)),
    );

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
      });

      const journal = new Journal(this.dataDirPath, project.name, issue.number);
      journal.append({ type: "fleet", event: "claimed", issue: issue.number, title: issue.title });

      await this.runSession(project, issue, worktree, journal, undefined, buildIssuePrompt(project, issue, comments));
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
  ): Promise<void> {
    const key = this.key(project.name, issue.number);
    const session = new WorkerSession({
      project,
      scope: key,
      worktreePath: worktree.path,
      journal,
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
      await this.supervise(project, issue, worktree, session);
    } finally {
      this.live.delete(key);
      this.replyWaiters.delete(key);
      session.close();
      this.state.update(project.name, issue.number, {
        sessionLive: false,
        sessionId: session.sessionId,
        costUsd: session.costUsd,
      });
      this.emitBoard();
    }
  }

  private async supervise(
    project: ProjectConfig,
    issue: ReadyIssue,
    worktree: Worktree,
    session: WorkerSession,
  ): Promise<void> {
    const key = this.key(project.name, issue.number);
    for (;;) {
      const turn = await session.nextResult(this.config.ticketTimeoutMinutes * 60_000);
      this.state.update(project.name, issue.number, {
        sessionId: session.sessionId,
        costUsd: session.costUsd,
        model: session.model,
        modelUsage: session.modelUsage,
      });

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
      await this.markWorking(project, record.issueNumber);
      const journal = new Journal(this.dataDirPath, project.name, record.issueNumber);
      journal.append({ type: "fleet", event: "resumed", sessionId: record.sessionId });
      await this.runSession(
        project,
        issue,
        { path: record.worktreePath, branch: record.branch },
        journal,
        record.sessionId,
        message,
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

  private async markWorking(project: ProjectConfig, issueNumber: number): Promise<void> {
    try {
      await swapLabel(project, issueNumber, FLEET_LABELS.needsInput, FLEET_LABELS.inProgress);
    } catch (err) {
      logError("loop", `${this.key(project.name, issueNumber)}: label swap to in-progress failed`, err);
    }
    this.state.update(project.name, issueNumber, { status: "running" });
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

  private async finishFailed(project: ProjectConfig, issue: ReadyIssue, error: string): Promise<void> {
    await upsertStatusComment(
      project,
      issue.number,
      [`**Status: failed**`, `The worker run failed: ${error}`, "Re-label with `fleet:ready` to retry, or reply from the dashboard to resume."].join("\n\n"),
    );
    await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput);
    this.state.update(project.name, issue.number, { status: "failed", lastSummary: error });
    this.emitBoard();
  }

  private async cleanupFinished(project: ProjectConfig, openIssues: { number: number }[]): Promise<void> {
    const openNumbers = new Set(openIssues.map((i) => i.number));
    for (const record of this.state.all()) {
      if (record.project !== project.name) continue;
      if (record.status !== "review" || !record.prUrl) continue;
      if (openNumbers.has(record.issueNumber)) continue;
      if (this.running.has(this.key(record.project, record.issueNumber))) continue;

      let prState: string;
      try {
        prState = await getPrState(project, record.prUrl);
      } catch (err) {
        logError("loop", `${record.project}#${record.issueNumber}: could not check PR state`, err);
        continue;
      }
      if (prState !== "MERGED" && prState !== "CLOSED") continue;

      log("loop", `${record.project}#${record.issueNumber}: PR ${prState.toLowerCase()} and issue closed — cleaning up worktree + branch ${record.branch}`);
      await removeWorktree(project, record.worktreePath);
      await run("git", ["-C", project.repoPath, "branch", "-D", record.branch], { allowFailure: true });
      this.state.remove(record.project, record.issueNumber);
      this.emitBoard();
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
    return [...this.boardCache.values()].flat().map((t) => ({
      ...t,
      record: this.state.get(t.project, t.issueNumber),
    }));
  }

  getProject(name: string): ProjectConfig | undefined {
    return this.config.projects.find((p) => p.name === name);
  }

  private emitBoard(): void {
    const now = Date.now();
    if (now - this.lastBoardEmit < 1000) return;
    this.lastBoardEmit = now;
    this.events.emit("board");
  }
}
