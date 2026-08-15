import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { ELEVATE_LABEL, LIGHT_LABEL, PLAN_LABEL, mergeModelUsage, type ProjectConfig, type TicketRecord } from "@fleet/shared";
import { key, markWorking, type LoopContext, type SessionBase } from "./context.ts";
import { reportRunFailure } from "./finish.ts";
import { getIssueLabels, type ReadyIssue } from "../github/github.ts";
import { Journal } from "../store/journal.ts";
import { log } from "../log.ts";
import { supervise } from "./supervise.ts";
import { WorkerSession, type SessionKind } from "../session/worker.ts";
import type { Worktree } from "../github/worktree.ts";

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
 * Routes every non-allowlisted tool call (and `AskUserQuestion`) to the
 * dashboard — except in `--once` mode, where no dashboard exists to answer, so
 * requests deny immediately instead of waiting out `approvalTimeoutMinutes`.
 */
export function makeCanUseTool(ctx: LoopContext, project: ProjectConfig, issueNumber: number): CanUseTool {
  return async (toolName, input, { signal }) => {
    const kind = toolName === "AskUserQuestion" ? "question" : "permission";
    if (ctx.once) {
      log("approvals", `${project.name}#${issueNumber}: ${toolName} auto-denied (--once mode has no dashboard to answer approvals)`);
      if (kind === "question") {
        return {
          behavior: "deny",
          message: `Approvals aren't available in --once mode (no dashboard is running to answer them). Finish with status "blocked" and restate your questions in blockedReason.`,
        };
      }
      return {
        behavior: "deny",
        message: `Approvals aren't available in --once mode (no dashboard is running to answer them). Find another way, or finish with status "blocked" explaining what you need.`,
      };
    }
    const outcome = await ctx.approvals.request({
      project: project.name,
      issueNumber,
      toolName,
      kind,
      input,
      timeoutMs: ctx.config.approvalTimeoutMinutes * 60_000,
      signal,
    });
    if (kind === "question") {
      if (outcome.message) {
        return { behavior: "deny", message: `The user answered your questions:\n\n${outcome.message}\n\nIncorporate these answers and continue.` };
      }
      return {
        behavior: "deny",
        message: `No answer arrived within ${ctx.config.approvalTimeoutMinutes} minutes. Finish with status "blocked" and restate your questions in blockedReason.`,
      };
    }
    if (outcome.allowed) return { behavior: "allow", updatedInput: input };
    return {
      behavior: "deny",
      message: outcome.message ?? `Denied via fleet dashboard (or approval timed out after ${ctx.config.approvalTimeoutMinutes} minutes). Find another way, or finish with status "blocked" explaining what you need.`,
    };
  };
}

export interface RunSessionOptions {
  project: ProjectConfig;
  issue: ReadyIssue;
  worktree: Worktree;
  journal: Journal;
  /** Set to resume an existing session rather than start a fresh one. */
  resumeSessionId?: string;
  firstMessage: string;
  elevated: boolean;
  light: boolean;
  kind: SessionKind;
}

/** Opens one worker session, supervises it to a terminal state, and tears it down. */
export async function runSession(ctx: LoopContext, opts: RunSessionOptions): Promise<void> {
  const { project, issue, worktree, journal, elevated, light } = opts;
  const scope = key(project.name, issue.number);
  const existing = ctx.state.get(project.name, issue.number);
  // `total_cost_usd`/`modelUsage` restart at zero for every resumed session, so
  // remember what the ticket had already spent and add to it.
  const base: SessionBase = { costUsd: existing?.costUsd ?? 0, modelUsage: existing?.modelUsage };
  const model = selectModel(project, { elevated, light });
  if (elevated && light) {
    log("loop", `${scope}: both ${ELEVATE_LABEL} and ${LIGHT_LABEL} are present — elevate wins`);
  }
  if (elevated && project.elevatedModel) {
    log("loop", `${scope}: running elevated on ${project.elevatedModel}`);
  } else if (!elevated && light && project.lightModel) {
    log("loop", `${scope}: running light on ${project.lightModel}`);
  }
  const session = new WorkerSession({
    project,
    scope,
    worktreePath: worktree.path,
    journal,
    model,
    kind: opts.kind,
    onActivity: (note) => {
      const record = ctx.state.get(project.name, issue.number);
      ctx.state.update(project.name, issue.number, {
        lastActivityAt: new Date().toISOString(),
        ...(note ? { lastActivityNote: note } : {}),
        ...(record?.status === "stalled" ? { status: "running" as const } : {}),
      });
      ctx.emitBoard();
    },
    canUseTool: makeCanUseTool(ctx, project, issue.number),
    claudeExecutable: ctx.config.claudeExecutable,
    resumeSessionId: opts.resumeSessionId,
  });
  ctx.live.set(scope, session);
  ctx.state.update(project.name, issue.number, { sessionLive: true });
  try {
    session.send(opts.firstMessage);
    await supervise(ctx, project, issue, worktree, session, base);
  } finally {
    ctx.live.delete(scope);
    ctx.replyWaiters.delete(scope);
    session.close();
    ctx.state.update(project.name, issue.number, {
      sessionLive: false,
      sessionId: session.sessionId,
      costUsd: base.costUsd + session.costUsd,
      modelUsage: mergeModelUsage(base.modelUsage, session.modelUsage),
    });
    ctx.emitBoard();
  }
}

/**
 * Resumes a recorded session in its existing worktree/branch — the shared path
 * behind stall recovery, PR-review feedback, and dashboard replies to a cold
 * ticket. Tier labels are re-read from GitHub so a label changed while the
 * ticket sat idle takes effect on the resumed run.
 */
export async function resumeTicket(
  ctx: LoopContext,
  project: ProjectConfig,
  record: TicketRecord,
  message: string,
): Promise<void> {
  const issue: ReadyIssue = { number: record.issueNumber, title: record.issueTitle, body: "", labels: [], author: "" };
  const scope = key(project.name, record.issueNumber);
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
    ctx.state.update(project.name, record.issueNumber, { elevated, light, isPlan });
    await markWorking(ctx, project, record.issueNumber);
    const journal = new Journal(ctx.dataDirPath, project.name, record.issueNumber);
    journal.append({ type: "fleet", event: "resumed", sessionId: record.sessionId, elevated, light, isPlan });
    await runSession(ctx, {
      project,
      issue,
      worktree: { path: record.worktreePath, branch: record.branch },
      journal,
      resumeSessionId: record.sessionId,
      firstMessage: message,
      elevated,
      light,
      kind: isPlan ? "plan" : "code",
    });
  } catch (err) {
    await reportRunFailure(ctx, project, issue, "resume failed", err);
  }
}
