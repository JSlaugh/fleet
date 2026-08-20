import { mergeModelUsage, type PlanResult, type ProjectConfig } from "@fleet/shared";
import { key, markWorking, type LoopContext, type SessionBase } from "./context.ts";
import { finishBlocked, finishCompleted, finishFailed, finishPlanned } from "./finish.ts";
import { MAX_TICKET_TIMEOUT_MINUTES, parseTicketTimeoutMinutes, upsertStatusComment, type ReadyIssue } from "../github/github.ts";
import { Journal } from "../store/journal.ts";
import { log, logError } from "../log.ts";
import { extendPause, handlePlanLimit } from "./pause.ts";
import { recordSpend } from "./budget.ts";
import { resolveTypeChecklist, resolveTypeVerify } from "../github/buildspec.ts";
import {
  buildMachineReviewFixPrompt,
  buildMachineReviewPrompt,
  buildPlanReviewFixPrompt,
  buildPlanReviewPrompt,
  isActionable,
  isPlanActionable,
  runMachineReview,
  runPlanReview,
  selectReviewEffort,
  selectReviewModel,
  shouldMachineReview,
  shouldReviewPlan,
} from "../session/review.ts";
import type { WorkerSession } from "../session/worker.ts";
import { collectBranchDiff, hasCommits, type Worktree } from "../github/worktree.ts";

/**
 * Drives one live session to a terminal state, one turn at a time: plan limits
 * pause the daemon, `completed` goes through the machine-review gate, `blocked`
 * parks for an operator reply, and anything else fails the ticket.
 */
export async function supervise(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: ReadyIssue,
  worktree: Worktree,
  session: WorkerSession,
  base: SessionBase,
): Promise<void> {
  const timeoutMinutes = resolveTimeoutMinutes(ctx, key(project.name, issue.number), issue.body);
  for (;;) {
    const turn = await session.nextResult(timeoutMinutes * 60_000);
    const newCostUsd = base.costUsd + session.costUsd;
    recordSpend(ctx, project.name, issue.number, newCostUsd);
    ctx.state.update(project.name, issue.number, {
      sessionId: session.sessionId,
      costUsd: newCostUsd,
      model: session.model,
      effort: session.effort,
      modelUsage: mergeModelUsage(base.modelUsage, session.modelUsage),
    });

    if (turn.errorSubtype === "plan_limit") {
      await handlePlanLimit(ctx, project, issue, turn.limitResetAt);
      return;
    }

    if (turn.kind === "plan") {
      if (turn.result?.status === "completed") {
        const gate = await planReviewGate(ctx, project, issue, worktree, base, turn.result);
        if (gate.action === "fixing") {
          session.send(gate.prompt);
          continue;
        }
        await finishPlanned(ctx, project, issue, turn.result);
        return;
      }
      if (turn.result?.status === "blocked") {
        const parked = await park(ctx, project, issue, session, turn.result, "Planner reported blocked without a reason.");
        if (parked === "closed") return;
        continue;
      }
      await finishFailed(ctx, project, issue, turn.errorSubtype ?? "unknown error");
      return;
    }

    if (turn.result?.status === "completed") {
      const gate = await machineReviewGate(ctx, project, issue, worktree, base);
      if (gate.action === "fixing") {
        session.send(gate.prompt);
        continue;
      }
      await finishCompleted(ctx, project, issue, worktree.path, worktree.branch, turn.result.summary, turn.result);
      return;
    }
    if (turn.result?.status === "blocked") {
      const parked = await park(ctx, project, issue, session, turn.result, "Worker reported blocked without a reason.");
      if (parked === "closed") return;
      continue;
    }
    await finishFailed(ctx, project, issue, turn.errorSubtype ?? "unknown error");
    return;
  }
}

/**
 * Per-ticket `Timeout:` override for the global `ticketTimeoutMinutes`, clamped to
 * `MAX_TICKET_TIMEOUT_MINUTES` so one runaway body value can't wedge a ticket at an
 * unbounded turn timeout. A missing or malformed line falls back to the global value
 * rather than erroring.
 */
export function resolveTimeoutMinutes(ctx: LoopContext, scope: string, body: string): number {
  const requested = parseTicketTimeoutMinutes(body);
  if (requested === undefined) return ctx.config.ticketTimeoutMinutes;
  if (requested > MAX_TICKET_TIMEOUT_MINUTES) {
    log("loop", `${scope}: requested Timeout ${requested}m exceeds the max — clamped to ${MAX_TICKET_TIMEOUT_MINUTES}m`);
    return MAX_TICKET_TIMEOUT_MINUTES;
  }
  return requested;
}

/**
 * Report a blocked turn and hold the session open for an operator reply. A reply
 * puts the ticket back to work and is fed to the still-live session (`"replied"`);
 * a timeout closes the session, which stays resumable from its recorded id
 * (`"closed"`).
 */
async function park(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: ReadyIssue,
  session: WorkerSession,
  result: { blockedReason?: string; summary: string },
  fallbackReason: string,
): Promise<"replied" | "closed"> {
  const scope = key(project.name, issue.number);
  await finishBlocked(ctx, project, issue, result.blockedReason ?? fallbackReason, result.summary);
  const reply = await waitForReply(ctx, scope, ctx.config.replyWaitMinutes * 60_000);
  if (reply === undefined) {
    log("loop", `${scope}: no reply within ${ctx.config.replyWaitMinutes}m — session closed, resumable from the dashboard`);
    return "closed";
  }
  await markWorking(ctx, project, issue.number);
  session.send(reply);
  return "replied";
}

function waitForReply(ctx: LoopContext, scope: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ctx.replyWaiters.delete(scope);
      resolve(undefined);
    }, timeoutMs);
    ctx.replyWaiters.set(scope, (message) => {
      clearTimeout(timer);
      ctx.replyWaiters.delete(scope);
      resolve(message);
    });
  });
}

/**
 * Machine pre-review of a completed code turn, before anything is pushed or a
 * PR exists. Returns "fixing" with a findings prompt for the still-live worker
 * session (one round max — `machineReviewOutcome` is the cap), or "proceed" to
 * fall through to `finishCompleted`. Fails open: a broken reviewer must never
 * block the pipeline, so every error path proceeds as if the review passed.
 */
export async function machineReviewGate(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: ReadyIssue,
  worktree: Worktree,
  base: SessionBase,
): Promise<{ action: "proceed" } | { action: "fixing"; prompt: string }> {
  const scope = key(project.name, issue.number);
  const record = ctx.state.get(project.name, issue.number);
  if (ctx.dryRun || !shouldMachineReview(project, record)) return { action: "proceed" };
  // An empty branch is finishCompleted's blocked-guard territory, not review's.
  if (!(await hasCommits(project, worktree.path))) return { action: "proceed" };

  const model = selectReviewModel(project);
  const effort = selectReviewEffort(project);
  // Persisted before the reviewer starts so a crash mid-review fails open
  // (the resumed completion sees the field set and skips straight to review).
  ctx.state.update(project.name, issue.number, {
    machineReviewOutcome: "pending",
    lastActivityAt: new Date().toISOString(),
    lastActivityNote: "machine review running",
  });
  ctx.emitBoard();
  const journal = new Journal(ctx.dataDirPath, project.name, issue.number);
  journal.append({ type: "fleet", event: "machine-review-started", model, effort });
  log("loop", `${scope}: machine review running${model ? ` on ${model}` : ""}${effort ? ` (effort ${effort})` : ""}`);

  let outcome;
  try {
    const { diff, commits } = await collectBranchDiff(project, worktree.path);
    const checklist = resolveTypeChecklist(scope, worktree.path, record?.ticketType);
    const verify = resolveTypeVerify(scope, worktree.path, record?.ticketType);
    outcome = await runMachineReview({
      scope,
      worktreePath: worktree.path,
      model,
      effort,
      prompt: buildMachineReviewPrompt(issue, commits, diff, project.defaultBranch, checklist, verify),
      claudeExecutable: ctx.config.claudeExecutable,
      journal,
    });
  } catch (err) {
    outcome = { costUsd: 0, errorSubtype: err instanceof Error ? err.message : String(err) };
  }

  // Reviewer spend joins the shared base so every later `base + session` write
  // carries it; the immediate update makes it visible on the dashboard now.
  base.costUsd += outcome.costUsd;
  base.modelUsage = mergeModelUsage(base.modelUsage, outcome.modelUsage);
  const reviewedCostUsd = (ctx.state.get(project.name, issue.number)?.costUsd ?? 0) + outcome.costUsd;
  recordSpend(ctx, project.name, issue.number, reviewedCostUsd);
  ctx.state.update(project.name, issue.number, {
    costUsd: reviewedCostUsd,
    modelUsage: base.modelUsage,
  });

  if (outcome.errorSubtype || !outcome.result) {
    journal.append({ type: "fleet", event: "machine-review-error", errorSubtype: outcome.errorSubtype });
    log("loop", `${scope}: machine review failed (${outcome.errorSubtype}) — proceeding to human review`);
    if (outcome.errorSubtype === "plan_limit") extendPause(ctx, project, issue, outcome.limitResetAt);
    ctx.state.update(project.name, issue.number, { machineReviewOutcome: "skipped" });
    return { action: "proceed" };
  }

  if (!isActionable(outcome.result)) {
    journal.append({ type: "fleet", event: "machine-review-passed", summary: outcome.result.summary });
    log("loop", `${scope}: machine review passed`);
    ctx.state.update(project.name, issue.number, { machineReviewOutcome: "passed" });
    return { action: "proceed" };
  }

  const findings = outcome.result.findings;
  journal.append({
    type: "fleet",
    event: "machine-review-findings",
    count: findings.length,
    severities: findings.map((f) => f.severity).filter((s): s is NonNullable<typeof s> => s !== undefined),
    files: findings.map((f) => f.file),
    findings,
  });
  log("loop", `${scope}: machine review found ${findings.length} issue(s) — sending the worker back for one fix round`);
  ctx.state.update(project.name, issue.number, {
    machineReviewOutcome: "findings",
    lastActivityNote: `machine review: ${findings.length} finding(s), fixing`,
  });
  ctx.emitBoard();
  try {
    await upsertStatusComment(
      project,
      issue.number,
      [
        `**Status: in progress**`,
        `Machine review found ${findings.length} issue(s); the worker is addressing them before human review.`,
        findings.map((f) => `- \`${f.line !== undefined ? `${f.file}:${f.line}` : f.file}\` — ${f.summary}`).join("\n"),
      ].join("\n\n"),
    );
  } catch (err) {
    logError("loop", `${scope}: could not post the machine-review status comment`, err);
  }
  return { action: "fixing", prompt: buildMachineReviewFixPrompt(outcome.result) };
}

/**
 * Plan-review counterpart of `machineReviewGate`, run over a completed plan
 * turn's `PlanResult.tickets[]` before `finishPlanned` files any of them as
 * real GitHub issues — the only unguarded completion path otherwise. Shares
 * the same one-shot read-only reviewer shape, the `machineReview` opt-out
 * switch, the `machineReviewOutcome` once-per-ticket cap, and the fail-open
 * contract with the code-review gate.
 */
export async function planReviewGate(
  ctx: LoopContext,
  project: ProjectConfig,
  issue: ReadyIssue,
  worktree: Worktree,
  base: SessionBase,
  result: PlanResult,
): Promise<{ action: "proceed" } | { action: "fixing"; prompt: string }> {
  const scope = key(project.name, issue.number);
  const record = ctx.state.get(project.name, issue.number);
  if (ctx.dryRun || !shouldReviewPlan(project, record)) return { action: "proceed" };

  const model = selectReviewModel(project);
  const effort = selectReviewEffort(project);
  // Persisted before the reviewer starts so a crash mid-review fails open
  // (the resumed completion sees the field set and skips straight to filing).
  ctx.state.update(project.name, issue.number, {
    machineReviewOutcome: "pending",
    lastActivityAt: new Date().toISOString(),
    lastActivityNote: "plan review running",
  });
  ctx.emitBoard();
  const journal = new Journal(ctx.dataDirPath, project.name, issue.number);
  journal.append({ type: "fleet", event: "plan-review-started", model, effort });
  log("loop", `${scope}: plan review running${model ? ` on ${model}` : ""}${effort ? ` (effort ${effort})` : ""}`);

  let outcome;
  try {
    outcome = await runPlanReview({
      scope,
      worktreePath: worktree.path,
      model,
      effort,
      prompt: buildPlanReviewPrompt(issue, result),
      claudeExecutable: ctx.config.claudeExecutable,
      journal,
    });
  } catch (err) {
    outcome = { costUsd: 0, errorSubtype: err instanceof Error ? err.message : String(err) };
  }

  base.costUsd += outcome.costUsd;
  base.modelUsage = mergeModelUsage(base.modelUsage, outcome.modelUsage);
  const reviewedCostUsd = (ctx.state.get(project.name, issue.number)?.costUsd ?? 0) + outcome.costUsd;
  recordSpend(ctx, project.name, issue.number, reviewedCostUsd);
  ctx.state.update(project.name, issue.number, {
    costUsd: reviewedCostUsd,
    modelUsage: base.modelUsage,
  });

  if (outcome.errorSubtype || !outcome.result) {
    journal.append({ type: "fleet", event: "plan-review-error", errorSubtype: outcome.errorSubtype });
    log("loop", `${scope}: plan review failed (${outcome.errorSubtype}) — proceeding to file the children`);
    if (outcome.errorSubtype === "plan_limit") extendPause(ctx, project, issue, outcome.limitResetAt);
    ctx.state.update(project.name, issue.number, { machineReviewOutcome: "skipped" });
    return { action: "proceed" };
  }

  if (!isPlanActionable(outcome.result)) {
    journal.append({ type: "fleet", event: "plan-review-passed", summary: outcome.result.summary });
    log("loop", `${scope}: plan review passed`);
    ctx.state.update(project.name, issue.number, { machineReviewOutcome: "passed" });
    return { action: "proceed" };
  }

  const findings = outcome.result.findings;
  journal.append({
    type: "fleet",
    event: "plan-review-findings",
    count: findings.length,
    severities: findings.map((f) => f.severity).filter((s): s is NonNullable<typeof s> => s !== undefined),
    ticketIndices: findings.map((f) => f.ticketIndex),
    findings,
  });
  log("loop", `${scope}: plan review found ${findings.length} issue(s) — sending the planner back for one fix round`);
  ctx.state.update(project.name, issue.number, {
    machineReviewOutcome: "findings",
    lastActivityNote: `plan review: ${findings.length} finding(s), fixing`,
  });
  ctx.emitBoard();
  try {
    await upsertStatusComment(
      project,
      issue.number,
      [
        `**Status: in progress**`,
        `Plan review found ${findings.length} issue(s); the planner is revising the decomposition before child tickets are filed.`,
        findings.map((f) => `- \`${f.ticketIndex !== undefined ? `ticket [${f.ticketIndex}]` : "decomposition"}\` — ${f.summary}`).join("\n"),
      ].join("\n\n"),
    );
  } catch (err) {
    logError("loop", `${scope}: could not post the plan-review status comment`, err);
  }
  return { action: "fixing", prompt: buildPlanReviewFixPrompt(outcome.result) };
}
