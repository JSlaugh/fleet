import { FLEET_LABELS, type FleetConfig, type ProjectConfig } from "@fleet/shared";
import {
  createPullRequest,
  getIssueComments,
  listReadyIssues,
  swapLabel,
  upsertStatusComment,
  type ReadyIssue,
} from "./github.ts";
import { Journal } from "./journal.ts";
import { log, logError } from "./log.ts";
import { StateStore } from "./state.ts";
import { runWorker } from "./worker.ts";
import { createWorktree, hasCommits, pushBranch } from "./worktree.ts";

const PR_FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

export class FleetLoop {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly config: FleetConfig,
    private readonly state: StateStore,
    private readonly dataDirPath: string,
    private readonly dryRun: boolean,
  ) {}

  private key(project: ProjectConfig, issueNumber: number): string {
    return `${project.name}#${issueNumber}`;
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
    const activeCount = [...this.running.keys()].filter((k) => k.startsWith(`${project.name}#`)).length;
    const capacity = project.maxConcurrent - activeCount;
    if (capacity <= 0) return;

    const ready = (await listReadyIssues(project)).filter(
      (issue) => !this.running.has(this.key(project, issue.number)),
    );
    if (ready.length === 0) return;

    for (const issue of ready.slice(0, capacity)) {
      if (this.dryRun) {
        log("loop", `[dry-run] would claim ${project.name}#${issue.number}: ${issue.title}`);
        continue;
      }
      const promise = this.processTicket(project, issue).finally(() => {
        this.running.delete(this.key(project, issue.number));
      });
      this.running.set(this.key(project, issue.number), promise);
    }
  }

  private async processTicket(project: ProjectConfig, issue: ReadyIssue): Promise<void> {
    const now = new Date().toISOString();
    const scope = `${project.name}#${issue.number}`;
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

      const run = await runWorker({
        project,
        issue,
        comments,
        worktreePath: worktree.path,
        journal,
        onActivity: () => {
          this.state.update(project.name, issue.number, { lastActivityAt: new Date().toISOString() });
        },
      });

      this.state.update(project.name, issue.number, { sessionId: run.sessionId, costUsd: run.costUsd });

      if (run.result?.status === "completed") {
        await this.finishCompleted(project, issue, worktree.path, worktree.branch, run.result.summary, run.result);
      } else if (run.result?.status === "blocked") {
        await this.finishBlocked(project, issue, run.result.blockedReason ?? "Worker reported blocked without a reason.", run.result.summary);
      } else {
        await this.finishFailed(project, issue, run.errorSubtype ?? "unknown error");
      }
    } catch (err) {
      logError("loop", `${scope} failed`, err);
      try {
        await this.finishFailed(project, issue, err instanceof Error ? err.message : String(err));
      } catch (reportErr) {
        logError("loop", `${scope}: could not report failure to GitHub`, reportErr);
      }
    }
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
    const prUrl = await createPullRequest(project, branch, result.prTitle ?? issue.title, prBody);
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
    log("loop", `${project.name}#${issue.number}: PR opened ${prUrl}`);
  }

  private async finishBlocked(project: ProjectConfig, issue: ReadyIssue, reason: string, summary?: string): Promise<void> {
    await upsertStatusComment(
      project,
      issue.number,
      [`**Status: needs input**`, summary ?? "", `Blocked on: ${reason}`].filter(Boolean).join("\n\n"),
    );
    await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput);
    this.state.update(project.name, issue.number, { status: "needs-input", lastSummary: reason });
    log("loop", `${project.name}#${issue.number}: needs input — ${reason}`);
  }

  private async finishFailed(project: ProjectConfig, issue: ReadyIssue, error: string): Promise<void> {
    await upsertStatusComment(
      project,
      issue.number,
      [`**Status: failed**`, `The worker run failed: ${error}`, "Re-label with `fleet:ready` to retry."].join("\n\n"),
    );
    await swapLabel(project, issue.number, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput);
    this.state.update(project.name, issue.number, { status: "failed", lastSummary: error });
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
}
