import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  MachineReviewResultSchema,
  PlanReviewResultSchema,
  type MachineReviewResult,
  type ModelUsageSummary,
  type PlanResult,
  type PlanReviewResult,
} from "@fleet/shared";
import type { Journal } from "../store/journal.ts";
import { log } from "../log.ts";
import { checkPlanLimit, summarize, summarizeModelUsage, type ToolTimings } from "./worker.ts";

/** Same top-level-object constraint as `WORKER_OUTPUT_SCHEMA` — see worker.ts. */
export const MACHINE_REVIEW_OUTPUT_SCHEMA = z.toJSONSchema(MachineReviewResultSchema, {
  target: "draft-7",
}) as Record<string, unknown>;

/** Same top-level-object constraint as `WORKER_OUTPUT_SCHEMA` — see worker.ts. */
export const PLAN_REVIEW_OUTPUT_SCHEMA = z.toJSONSchema(PlanReviewResultSchema, {
  target: "draft-7",
}) as Record<string, unknown>;

/** Kept under the 10-minute `stalledAfterMinutes` default so a running review can't trip the stall flagger. */
export const MACHINE_REVIEW_TIMEOUT_MS = 8 * 60_000;

const DIFF_CHAR_LIMIT = 80_000;

const REVIEWER_CONTRACT = `
You are a fleet machine reviewer: a cheap pre-review pass over one ticket's branch diff before it goes to a human.

Contract:
- Read-only. You may Read/Grep/Glob files in this worktree for context. Never modify anything.
- Do NOT run tests or builds — they already ran in the worker session that produced this diff.
- Report real defects only: bugs, broken edge cases, unmet requirements from the ticket, dangerous changes (data loss, security), contract violations with surrounding code.
- Do NOT report style, formatting, or preference nits. "pass" is the normal outcome for competent work.
- A "findings" verdict sends the worker back for exactly one fix round — use it only when a fix is genuinely needed. Cap findings at the ~8 that matter most; each must name the file (line if known), what is wrong, and why it matters.
`.trim();

const PLAN_REVIEWER_CONTRACT = `
You are a fleet plan reviewer: a cheap pre-review pass over a proposed decomposition of an epic into child tickets, before those children are filed as real GitHub issues.

Contract:
- Read-only. You may Read/Grep/Glob files in this worktree for context. Never modify anything.
- Judge each proposed child ticket: is it self-contained (a competent engineer could implement it without reading the sibling tickets) and PR-sized (not another epic in disguise)?
- Judge the decomposition as a whole: does it cover the epic's stated scope, or is something obviously missing?
- Do NOT report style, wording, or preference nits. "pass" is the normal outcome for a competent decomposition.
- A "findings" verdict sends the planner back for exactly one fix round — use it only when a real revision is needed. Cap findings at the ~8 that matter most; each finding should say which child ticket it concerns (by index), or note that it's about the decomposition as a whole.
`.trim();

/**
 * Whether a just-completed code turn should get a machine review. False once
 * `machineReviewOutcome` has any value — that field is the once-per-ticket cap,
 * so fix rounds, stall resumes, and human-feedback rounds all skip straight to
 * human review.
 */
export function shouldMachineReview(
  project: { machineReview?: boolean },
  record: { machineReviewOutcome?: string; isPlan?: boolean } | undefined,
): boolean {
  if (project.machineReview === false) return false;
  if (record?.isPlan) return false;
  if (record?.machineReviewOutcome !== undefined) return false;
  return true;
}

/**
 * Whether a just-completed plan turn should get a plan review, before its
 * children are filed. Shares `project.machineReview` (one opt-out switch for
 * both gates) and the `machineReviewOutcome` once-per-ticket cap with
 * `shouldMachineReview`, so a fix round or resumed plan never reviews twice.
 */
export function shouldReviewPlan(
  project: { machineReview?: boolean },
  record: { machineReviewOutcome?: string } | undefined,
): boolean {
  if (project.machineReview === false) return false;
  if (record?.machineReviewOutcome !== undefined) return false;
  return true;
}

/**
 * The reviewer always runs on the cheapest configured tier — unlike
 * `selectModel` this is not label-driven, so it lives here rather than widening
 * that signature.
 */
export function selectReviewModel(project: { model?: string; lightModel?: string }): string | undefined {
  return project.lightModel ?? project.model;
}

export function truncateDiff(diff: string, max: number = DIFF_CHAR_LIMIT): string {
  if (diff.length <= max) return diff;
  return `${diff.slice(0, max)}\n[diff truncated at ${max} characters — use Read/Grep to inspect the rest]`;
}

/**
 * `checklist` is the claimed ticket type's `review:` markdown from
 * `fleet.yaml` (#158) — explicit dimensions layered on top of the generic
 * pass, not a replacement for it. Undefined for untyped tickets or a type
 * with no declared checklist, in which case the prompt is unchanged.
 *
 * `verifyCommands` is the type's declared `verify:` commands (#160). The
 * reviewer is read-only, so it can't run them itself — it's asked to check
 * the diff and commit history for evidence they were run instead.
 */
export function buildMachineReviewPrompt(
  issue: { number: number; title: string; body: string },
  commits: string,
  diff: string,
  defaultBranch: string,
  checklist?: string,
  verifyCommands?: string[],
): string {
  return [
    `Review the branch diff for GitHub issue #${issue.number}: ${issue.title}`,
    issue.body || "(no description)",
    `## Commits\n\n${commits || "(none)"}`,
    `## Diff (against origin/${defaultBranch})\n\n\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``,
    checklist ? `## Additional review dimensions for this ticket's type\n\n${checklist}` : "",
    verifyCommands && verifyCommands.length > 0
      ? [
          "## Required verification for this ticket type",
          "",
          "This ticket's type requires the following commands to have been run before completion. You cannot run them yourself — check the diff and commit history for evidence they were run, and raise a finding if there's no such evidence:",
          "",
          ...verifyCommands.map((c) => `- \`${c}\``),
        ].join("\n")
      : "",
    `Judge whether this diff correctly and completely resolves the issue. Finish with your structured verdict.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A findings verdict with an empty findings list is treated as a pass. */
export function isActionable(result: MachineReviewResult): boolean {
  return result.verdict === "findings" && result.findings.length > 0;
}

export function buildMachineReviewFixPrompt(result: MachineReviewResult): string {
  const findings = result.findings
    .map((f) => {
      const location = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
      const severity = f.severity ? ` (${f.severity})` : "";
      return `**${location}**${severity}: ${f.summary}\n${f.detail}`;
    })
    .join("\n\n");
  return [
    "An automated pre-review of your branch diff found issues before it goes to human review.",
    result.summary,
    `## Findings\n\n${findings}`,
    "Address each finding (or explain in your final summary why one is not a real issue), commit your changes, and finish with an updated structured result.",
  ].join("\n\n");
}

export function buildPlanReviewPrompt(
  issue: { number: number; title: string; body: string },
  result: PlanResult,
): string {
  const tickets = result.tickets
    .map((t, i) =>
      [
        `### [${i}] ${t.title}${t.tier ? ` (tier: ${t.tier})` : ""}${t.priority ? ` (${t.priority})` : ""}`,
        t.dependsOnIndex?.length ? `Depends on: ${t.dependsOnIndex.join(", ")}` : "",
        t.body,
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\n\n---\n\n");
  return [
    `Review the proposed decomposition of GitHub epic #${issue.number}: ${issue.title}`,
    issue.body || "(no description)",
    `## Planner's summary\n\n${result.summary}`,
    `## Proposed child tickets\n\n${tickets || "(none proposed)"}`,
    `Judge whether each child ticket is self-contained and PR-sized, and whether the decomposition covers the epic's scope. Finish with your structured verdict.`,
  ].join("\n\n");
}

/** A findings verdict with an empty findings list is treated as a pass. */
export function isPlanActionable(result: PlanReviewResult): boolean {
  return result.verdict === "findings" && result.findings.length > 0;
}

export function buildPlanReviewFixPrompt(result: PlanReviewResult): string {
  const findings = result.findings
    .map((f) => {
      const location = f.ticketIndex !== undefined ? `child ticket [${f.ticketIndex}]` : "the decomposition as a whole";
      const severity = f.severity ? ` (${f.severity})` : "";
      return `**${location}**${severity}: ${f.summary}\n${f.detail}`;
    })
    .join("\n\n");
  return [
    "An automated pre-review of your proposed decomposition found issues before the child tickets are filed.",
    result.summary,
    `## Findings\n\n${findings}`,
    "Revise tickets[] to address each finding (or explain in your final summary why one is not a real issue), and finish with an updated structured result.",
  ].join("\n\n");
}

interface ReviewSessionOutcome<T> {
  result?: T;
  /** "timed out" | "invalid_structured_output" | "plan_limit" | error-result subtype | thrown-error text. */
  errorSubtype?: string;
  limitResetAt?: string;
  costUsd: number;
  modelUsage?: Record<string, ModelUsageSummary>;
  /** Journaled for traceability only — never written to `TicketRecord.sessionId`. */
  sessionId?: string;
}

export type MachineReviewOutcome = ReviewSessionOutcome<MachineReviewResult>;
export type PlanReviewOutcome = ReviewSessionOutcome<PlanReviewResult>;

/**
 * One-shot read-only review session shared by the machine-review (code) and
 * plan-review gates. Deliberately NOT a `WorkerSession`: it needs no streaming
 * input, no reply steering, and no dashboard approvals — and running it through
 * `runSession` would clobber the live session's recorded `sessionId`, breaking
 * later resumes. Never throws; every failure comes back as `errorSubtype` so
 * the caller can fail open.
 */
async function runReviewSession<T>(opts: {
  scope: string;
  worktreePath: string;
  model?: string;
  prompt: string;
  claudeExecutable?: string;
  journal: Journal;
  timeoutMs: number;
  systemPromptAppend: string;
  outputSchema: Record<string, unknown>;
  parseResult: (structuredOutput: unknown) => T | undefined;
  /** Tags each journaled message so the dashboard can tell this transcript apart from the live session's. */
  journalSession: string;
  /** Used in the read-only tool-denial message and log lines, e.g. "machine review" / "plan review". */
  logLabel: string;
}): Promise<ReviewSessionOutcome<T>> {
  const outcome: ReviewSessionOutcome<T> = { costUsd: 0 };
  const { timeoutMs } = opts;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const toolTimings: ToolTimings = new Map();
  try {
    const q = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.worktreePath,
        model: opts.model,
        abortController,
        pathToClaudeCodeExecutable: opts.claudeExecutable,
        permissionMode: "default",
        allowedTools: ["Read", "Grep", "Glob"],
        canUseTool: async (toolName) => ({
          behavior: "deny",
          message: `${toolName} is not available to the ${opts.logLabel} pass — it is read-only. Use Read/Grep/Glob, then finish with your structured verdict.`,
        }),
        settingSources: ["project"],
        thinking: { type: "adaptive", display: "summarized" },
        systemPrompt: { type: "preset", preset: "claude_code", append: opts.systemPromptAppend },
        outputFormat: { type: "json_schema", schema: opts.outputSchema },
      },
    });
    for await (const message of q) {
      opts.journal.append({ ...summarize(message, { toolTimings }), session: opts.journalSession });
      if (message.type === "system" && message.subtype === "init") {
        outcome.sessionId = message.session_id;
        log("review", `${opts.scope}: ${opts.logLabel} session ${message.session_id} started (${message.model})`);
      }
      if (message.type === "result") {
        outcome.costUsd = message.total_cost_usd;
        outcome.modelUsage = summarizeModelUsage(message.modelUsage);
      }
      const planLimit = checkPlanLimit(message);
      if (planLimit) {
        outcome.errorSubtype = "plan_limit";
        outcome.limitResetAt = planLimit.limitResetAt?.toISOString();
        return outcome;
      }
      if (message.type === "result") {
        if (message.subtype !== "success") {
          outcome.errorSubtype = message.subtype;
          return outcome;
        }
        const parsed = opts.parseResult((message as { structured_output?: unknown }).structured_output);
        if (parsed !== undefined) outcome.result = parsed;
        else outcome.errorSubtype = "invalid_structured_output";
        return outcome;
      }
    }
    outcome.errorSubtype = "stream_ended_without_result";
    return outcome;
  } catch (err) {
    if (err instanceof AbortError || abortController.signal.aborted) {
      outcome.errorSubtype = `timed out after ${Math.round(timeoutMs / 60_000)} minutes`;
    } else {
      outcome.errorSubtype = err instanceof Error ? err.message : String(err);
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

export async function runMachineReview(opts: {
  scope: string;
  worktreePath: string;
  model?: string;
  prompt: string;
  claudeExecutable?: string;
  journal: Journal;
  timeoutMs?: number;
}): Promise<MachineReviewOutcome> {
  return runReviewSession({
    ...opts,
    timeoutMs: opts.timeoutMs ?? MACHINE_REVIEW_TIMEOUT_MS,
    systemPromptAppend: REVIEWER_CONTRACT,
    outputSchema: MACHINE_REVIEW_OUTPUT_SCHEMA,
    journalSession: "machine-review",
    logLabel: "machine reviewer",
    parseResult: (structuredOutput) => {
      const parsed = MachineReviewResultSchema.safeParse(structuredOutput);
      return parsed.success ? parsed.data : undefined;
    },
  });
}

export async function runPlanReview(opts: {
  scope: string;
  worktreePath: string;
  model?: string;
  prompt: string;
  claudeExecutable?: string;
  journal: Journal;
  timeoutMs?: number;
}): Promise<PlanReviewOutcome> {
  return runReviewSession({
    ...opts,
    timeoutMs: opts.timeoutMs ?? MACHINE_REVIEW_TIMEOUT_MS,
    systemPromptAppend: PLAN_REVIEWER_CONTRACT,
    outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
    journalSession: "plan-review",
    logLabel: "plan reviewer",
    parseResult: (structuredOutput) => {
      const parsed = PlanReviewResultSchema.safeParse(structuredOutput);
      return parsed.success ? parsed.data : undefined;
    },
  });
}
