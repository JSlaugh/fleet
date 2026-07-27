import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  MachineReviewResultSchema,
  type MachineReviewResult,
  type ModelUsageSummary,
} from "@fleet/shared";
import type { Journal } from "./journal.ts";
import { log } from "./log.ts";
import { findLimitText, parseLimitReset, summarize, summarizeModelUsage } from "./worker.ts";

/** Same top-level-object constraint as `WORKER_OUTPUT_SCHEMA` — see worker.ts. */
export const MACHINE_REVIEW_OUTPUT_SCHEMA = z.toJSONSchema(MachineReviewResultSchema, {
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

export function buildMachineReviewPrompt(
  issue: { number: number; title: string; body: string },
  commits: string,
  diff: string,
  defaultBranch: string,
): string {
  return [
    `Review the branch diff for GitHub issue #${issue.number}: ${issue.title}`,
    issue.body || "(no description)",
    `## Commits\n\n${commits || "(none)"}`,
    `## Diff (against origin/${defaultBranch})\n\n\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``,
    `Judge whether this diff correctly and completely resolves the issue. Finish with your structured verdict.`,
  ].join("\n\n");
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

export interface MachineReviewOutcome {
  result?: MachineReviewResult;
  /** "timed out" | "invalid_structured_output" | "plan_limit" | error-result subtype | thrown-error text. */
  errorSubtype?: string;
  limitResetAt?: string;
  costUsd: number;
  modelUsage?: Record<string, ModelUsageSummary>;
  /** Journaled for traceability only — never written to `TicketRecord.sessionId`. */
  sessionId?: string;
}

/**
 * One-shot read-only review session. Deliberately NOT a `WorkerSession`: it
 * needs no streaming input, no reply steering, and no dashboard approvals — and
 * running it through `runSession` would clobber the code session's recorded
 * `sessionId`, breaking later review-feedback resumes. Never throws; every
 * failure comes back as `errorSubtype` so the caller can fail open.
 */
export async function runMachineReview(opts: {
  scope: string;
  worktreePath: string;
  model?: string;
  prompt: string;
  claudeExecutable?: string;
  journal: Journal;
  timeoutMs?: number;
}): Promise<MachineReviewOutcome> {
  const outcome: MachineReviewOutcome = { costUsd: 0 };
  const timeoutMs = opts.timeoutMs ?? MACHINE_REVIEW_TIMEOUT_MS;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
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
          message: `${toolName} is not available to the machine reviewer — it is a read-only pass. Use Read/Grep/Glob, then finish with your structured verdict.`,
        }),
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: REVIEWER_CONTRACT },
        outputFormat: { type: "json_schema", schema: MACHINE_REVIEW_OUTPUT_SCHEMA },
      },
    });
    for await (const message of q) {
      opts.journal.append({ ...summarize(message), session: "machine-review" });
      if (message.type === "system" && message.subtype === "init") {
        outcome.sessionId = message.session_id;
        log("review", `${opts.scope}: machine review session ${message.session_id} started (${message.model})`);
      }
      if (message.type === "result") {
        outcome.costUsd = message.total_cost_usd;
        outcome.modelUsage = summarizeModelUsage(message.modelUsage);
      }
      const limitText = findLimitText(message);
      if (limitText) {
        outcome.errorSubtype = "plan_limit";
        outcome.limitResetAt = parseLimitReset(limitText)?.toISOString();
        return outcome;
      }
      if (message.type === "result") {
        if (message.subtype !== "success") {
          outcome.errorSubtype = message.subtype;
          return outcome;
        }
        const parsed = MachineReviewResultSchema.safeParse((message as { structured_output?: unknown }).structured_output);
        if (parsed.success) outcome.result = parsed.data;
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
