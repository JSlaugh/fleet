import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { tierForType, ELEVATE_LABEL, LIGHT_LABEL, PLAN_LABEL, mergeModelUsage, type Effort, type ProjectConfig, type TicketRecord, type Tier } from "@fleet/shared";
import { key, markWorking, type LoopContext, type SessionBase } from "./context.ts";
import { reportRunFailure } from "./finish.ts";
import { readBuildSpec, resolveTypeContract, resolveTypeVerify } from "../github/buildspec.ts";
import { getIssue, type ReadyIssue } from "../github/github.ts";
import { Journal } from "../store/journal.ts";
import { log, logError } from "../log.ts";
import { supervise } from "./supervise.ts";
import { WorkerSession, type SessionKind } from "../session/worker.ts";
import type { Worktree } from "../github/worktree.ts";

/**
 * Which model a ticket's session should run on, most specific wins:
 * `fleet:elevate`/`fleet:light` labels (elevate wins when both are present —
 * elevation is an escalation signal) beat the ticket's `fleet.yaml` type's
 * declared `tier:`, which in turn beats the project default. Every tier
 * falls through to the project default when its matching tier model isn't
 * configured.
 */
export function selectModel(
  project: { model?: string; elevatedModel?: string; lightModel?: string },
  opts: { elevated: boolean; light: boolean; typeTier?: Tier },
): string | undefined {
  if (opts.elevated) return project.elevatedModel ?? project.model;
  if (opts.light) return project.lightModel ?? project.model;
  if (opts.typeTier === "elevated") return project.elevatedModel ?? project.model;
  if (opts.typeTier === "light") return project.lightModel ?? project.model;
  return project.model;
}

/**
 * Reasoning-effort counterpart of `selectModel`: same `fleet:elevate`/
 * `fleet:light` label precedence, but no `fleet.yaml` type tier yet (that's
 * #159's territory — a per-type `effort:` would slot in ahead of the project
 * default here, same as `typeTier` does above). Unlike `selectModel`, an
 * unset tier field does NOT fall back to a sibling tier — only to the plain
 * `effort` default, and from there to `undefined` (the SDK's own default),
 * since "no override" is a meaningful choice per tier rather than always
 * implying "use the standard tier's value."
 */
export function selectEffort(
  project: { effort?: Effort; elevatedEffort?: Effort; lightEffort?: Effort },
  opts: { elevated: boolean; light: boolean },
): Effort | undefined {
  if (opts.elevated) return project.elevatedEffort ?? project.effort;
  if (opts.light) return project.lightEffort ?? project.effort;
  return project.effort;
}

/**
 * Routes every non-allowlisted tool call (and `AskUserQuestion`) to the
 * dashboard — except in `--once` mode, where no dashboard exists to answer, so
 * requests deny immediately instead of waiting out `approvalTimeoutMinutes`.
 */
export function makeCanUseTool(ctx: LoopContext, project: ProjectConfig, issueNumber: number, journal: Journal): CanUseTool {
  return async (toolName, input, { signal }) => {
    const kind = toolName === "AskUserQuestion" ? "question" : "permission";
    if (ctx.once) {
      log("approvals", `${project.name}#${issueNumber}: ${toolName} auto-denied (--once mode has no dashboard to answer approvals)`);
      journal.append({ type: "fleet", event: "approval-decided", toolName, kind, outcome: "auto-denied", waitMs: 0 });
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
    const requestedAt = Date.now();
    const outcome = await ctx.approvals.request({
      project: project.name,
      issueNumber,
      toolName,
      kind,
      input,
      timeoutMs: ctx.config.approvalTimeoutMinutes * 60_000,
      signal,
    });
    journal.append({
      type: "fleet",
      event: "approval-decided",
      toolName,
      kind,
      outcome: outcome.reason ?? (outcome.allowed ? "allowed" : "denied"),
      waitMs: Date.now() - requestedAt,
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
  /** `TicketRecord.ticketType` — which of the repo's `fleet.yaml` profiles (if any) this ticket's contract appendix comes from. */
  ticketType?: string;
}

/**
 * Same re-read-fresh, fail-open posture as `resolveTypeContract`
 * (`../github/buildspec.ts`), for the
 * type's declared `tier:` instead of its `contract:` — a resumed session
 * picks up a since-edited tier same as a fresh claim would, and a
 * missing/malformed spec at session-open time falls back to no tier override
 * (project default) rather than blocking the session.
 */
export function resolveTypeTier(scope: string, worktreePath: string, ticketType: string | undefined): Tier | undefined {
  if (!ticketType) return undefined;
  try {
    const spec = readBuildSpec(worktreePath);
    return spec ? tierForType(spec, ticketType) : undefined;
  } catch (err) {
    logError("loop", `${scope}: could not re-read fleet.yaml for ticketType "${ticketType}" — running without its tier override`, err);
    return undefined;
  }
}

/** Opens one worker session, supervises it to a terminal state, and tears it down. */
export async function runSession(ctx: LoopContext, opts: RunSessionOptions): Promise<void> {
  const { project, issue, worktree, journal, elevated, light } = opts;
  const scope = key(project.name, issue.number);
  const existing = ctx.state.get(project.name, issue.number);
  // `total_cost_usd`/`modelUsage` restart at zero for every resumed session, so
  // remember what the ticket had already spent and add to it.
  const base: SessionBase = { costUsd: existing?.costUsd ?? 0, modelUsage: existing?.modelUsage };
  const typeTier = resolveTypeTier(scope, worktree.path, opts.ticketType);
  const model = selectModel(project, { elevated, light, typeTier });
  const effort = selectEffort(project, { elevated, light });
  if (elevated && light) {
    log("loop", `${scope}: both ${ELEVATE_LABEL} and ${LIGHT_LABEL} are present — elevate wins`);
  }
  if (elevated && project.elevatedModel) {
    log("loop", `${scope}: running elevated on ${project.elevatedModel}`);
  } else if (!elevated && light && project.lightModel) {
    log("loop", `${scope}: running light on ${project.lightModel}`);
  } else if (!elevated && !light && typeTier === "elevated" && project.elevatedModel) {
    log("loop", `${scope}: running fleet.yaml type "${opts.ticketType}"'s tier "elevated" on ${project.elevatedModel}`);
    journal.append({ type: "fleet", event: "type-tier-applied", ticketType: opts.ticketType, tier: typeTier, model });
  } else if (!elevated && !light && typeTier === "light" && project.lightModel) {
    log("loop", `${scope}: running fleet.yaml type "${opts.ticketType}"'s tier "light" on ${project.lightModel}`);
    journal.append({ type: "fleet", event: "type-tier-applied", ticketType: opts.ticketType, tier: typeTier, model });
  }
  if (elevated && project.elevatedEffort) {
    log("loop", `${scope}: running elevated effort ${project.elevatedEffort}`);
  } else if (!elevated && light && project.lightEffort) {
    log("loop", `${scope}: running light effort ${project.lightEffort}`);
  }
  const contract = resolveTypeContract(scope, worktree.path, opts.ticketType);
  const verify = resolveTypeVerify(scope, worktree.path, opts.ticketType);
  const session = new WorkerSession({
    project,
    scope,
    worktreePath: worktree.path,
    journal,
    model,
    effort,
    kind: opts.kind,
    contract,
    verify,
    onActivity: (note) => {
      const record = ctx.state.get(project.name, issue.number);
      ctx.state.update(project.name, issue.number, {
        lastActivityAt: new Date().toISOString(),
        ...(note ? { lastActivityNote: note } : {}),
        ...(record?.status === "stalled" ? { status: "running" as const } : {}),
      });
      ctx.emitBoard();
    },
    canUseTool: makeCanUseTool(ctx, project, issue.number, journal),
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
  reason?: string,
): Promise<void> {
  const issue: ReadyIssue = { number: record.issueNumber, title: record.issueTitle, body: "", labels: [], author: "" };
  const scope = key(project.name, record.issueNumber);
  log("loop", `${scope}: resuming session ${record.sessionId}`);
  try {
    let elevated = record.elevated ?? false;
    let light = record.light ?? false;
    let isPlan = record.isPlan ?? false;
    try {
      // One fetch for labels *and* body: the tier labels drive model selection,
      // and the real body keeps per-ticket `Timeout:` overrides working on a
      // resumed session — and keeps downstream consumers (the plan path's epic
      // body stamp) from ever seeing a synthesized-empty body.
      const live = await getIssue(project, record.issueNumber);
      if (live) {
        issue.body = live.body;
        elevated = live.labels.includes(ELEVATE_LABEL);
        light = live.labels.includes(LIGHT_LABEL);
        isPlan = live.labels.includes(PLAN_LABEL);
      }
    } catch {
      // best-effort; fall back to the recorded flags and an empty body
    }
    ctx.state.update(project.name, record.issueNumber, { elevated, light, isPlan });
    await markWorking(ctx, project, record.issueNumber);
    const journal = new Journal(ctx.dataDirPath, project.name, record.issueNumber);
    journal.append({ type: "fleet", event: "resumed", sessionId: record.sessionId, elevated, light, isPlan, reason });
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
      ticketType: record.ticketType,
    });
  } catch (err) {
    await reportRunFailure(ctx, project, issue, "resume failed", err);
  }
}
