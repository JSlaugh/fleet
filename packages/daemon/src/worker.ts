import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, HookCallback, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  PlanResultSchema,
  WorkerResultSchema,
  type ModelUsageSummary,
  type PlanResult,
  type ProjectConfig,
  type WorkerResult,
} from "@fleet/shared";
import type { Journal } from "./journal.ts";
import { log } from "./log.ts";
import { MessageQueue } from "./queue.ts";

export type SessionKind = "code" | "plan";

/**
 * The SDK hands `outputFormat`'s schema to the API as the `StructuredOutput`
 * tool's `input_schema`, and the API rejects `oneOf`/`allOf`/`anyOf` at the top
 * level of a tool schema. Bolting draft-7 conditionals on here to express
 * "prTitle is required when status is completed" therefore 400s every worker
 * session on its first request, before the model sees anything. The conditional
 * half of the output contract lives in `WORKER_CONTRACT` prose and in the
 * per-property descriptions instead; the fallbacks in `supervise.ts` are the
 * safety net when a worker ignores it.
 */
export const WORKER_OUTPUT_SCHEMA = z.toJSONSchema(WorkerResultSchema, {
  target: "draft-7",
}) as Record<string, unknown>;

export const PLAN_OUTPUT_SCHEMA = z.toJSONSchema(PlanResultSchema, {
  target: "draft-7",
}) as Record<string, unknown>;

const DEFAULT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "TodoWrite", "Skill", "Agent", "Task", "mcp__fleet"];

const WORKER_CONTRACT = `
You are a fleet worker: an autonomous coding agent handling exactly one GitHub issue in a dedicated git worktree.

Contract:
- Work only within this worktree. The branch already exists and is checked out; never switch branches, never push, and never open PRs — the orchestrator handles those.
- Commit incrementally with clear conventional-commit messages as you complete coherent steps.
- Run the project's own checks (tests, typecheck, lint) before declaring completion when they exist.
- If you hit a decision the issue does not answer, do NOT guess: finish with status "blocked" and put the specific question in blockedReason. A human may answer in a follow-up message — then continue the work.
- Your final structured output: status "completed" requires prTitle and prBody; status "blocked" requires blockedReason.
`.trim();

const PLANNER_CONTRACT = `
You are a fleet planning agent: you decompose an epic-level GitHub issue into independent, PR-sized child tickets instead of writing code.

Contract:
- Work only within this worktree, read-only: explore the repo (CLAUDE.md, skills, existing code) for context, but do NOT write or edit any files, and do NOT commit.
- Each child ticket must be self-contained: its body states the problem, acceptance criteria, and how to verify it, and it must be independently implementable as its own PR-sized change.
- Prefer several small, independent tickets over one large one; avoid tickets that depend on landing in a specific order unless the epic genuinely requires it.
- If the epic is too ambiguous to decompose confidently, do NOT guess: finish with status "blocked" and put the specific question in blockedReason.
- Your final structured output lists every proposed child ticket in tickets[].
`.trim();

export const FORBIDDEN_BASH_REASON =
  "The fleet orchestrator handles pushing, PRs, and issue state. Finish your work and report via your structured result instead.";

export const FORBIDDEN_COMMIT_REASON =
  "This is a planning session: explore the repo read-only and propose child tickets instead of committing changes.";

/**
 * `Bash` is allowlisted, and allowlisted tools bypass `canUseTool` entirely, so
 * the "never push, never open PRs" half of the worker contract has to be
 * enforced here or not at all.
 *
 * Each pattern spans a single command: `[^;|&\n]` keeps a match from running
 * across `&&`, `;`, `|` or a newline, so `git status && pnpm push` is not read as
 * `git push`, while `git -C ../x push` still is. Quoted text is not parsed out —
 * `echo "git push"` is denied too. Over-blocking costs the worker one retry;
 * under-blocking corrupts the orchestrator's state machine.
 */
const FORBIDDEN_BASH_PATTERNS: RegExp[] = [
  // git push, including `git -C <path> push` and `git push --force`
  /\bgit\b[^;|&\n]*?\s+push\b/i,
  // the whole `gh pr` surface except the read-only `gh pr view` / `gh pr diff`
  /\bgh\b[^;|&\n]*?\s+pr\b(?!\s+(?:view|diff)\b)/i,
  // issue state the orchestrator owns
  /\bgh\b[^;|&\n]*?\s+issue\s+(?:edit|close|comment)\b/i,
  /\bgh\b[^;|&\n]*?\s+label\b/i,
];

export function isForbiddenBashCommand(command: string): boolean {
  return FORBIDDEN_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

export const denyForbiddenBash: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return { continue: true };
  const command = (input.tool_input as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== "string" || !isForbiddenBashCommand(command)) return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: FORBIDDEN_BASH_REASON,
    },
  };
};

/** A planner must not commit either — same single-command scoping as `FORBIDDEN_BASH_PATTERNS`. */
const FORBIDDEN_COMMIT_PATTERN = /\bgit\b[^;|&\n]*?\s+commit\b/i;

export function isForbiddenPlanBashCommand(command: string): boolean {
  return isForbiddenBashCommand(command) || FORBIDDEN_COMMIT_PATTERN.test(command);
}

export const denyForbiddenPlanBash: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return { continue: true };
  const command = (input.tool_input as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== "string" || !isForbiddenPlanBashCommand(command)) return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: FORBIDDEN_COMMIT_PATTERN.test(command) ? FORBIDDEN_COMMIT_REASON : FORBIDDEN_BASH_REASON,
    },
  };
};

export interface CodeTurnResult {
  kind: "code";
  result?: WorkerResult;
  errorSubtype?: string;
  /** Set alongside `errorSubtype: "plan_limit"` when a reset time could be parsed out of the limit message. */
  limitResetAt?: string;
}

export interface PlanTurnResult {
  kind: "plan";
  result?: PlanResult;
  errorSubtype?: string;
  limitResetAt?: string;
}

export type TurnResult = CodeTurnResult | PlanTurnResult;

/**
 * The reliable, reactive signal for a plan usage-limit hit: no API exposes remaining
 * capacity, but a message whose text matches this has historically carried the reset
 * time either as an epoch-seconds suffix (`Claude AI usage limit reached|1735689600`)
 * or in a human-readable "resets ..." clause.
 */
const USAGE_LIMIT_PATTERN = /usage limit reached/i;

/**
 * Pure so it can be unit-tested against both known text shapes without spinning up a
 * session. Returns `undefined` for text that isn't a limit message at all, and for a
 * limit message whose reset time can't be parsed out of it — callers fall back to a
 * configured default backoff in either case.
 */
export function parseLimitReset(text: string): Date | undefined {
  if (!USAGE_LIMIT_PATTERN.test(text)) return undefined;

  const epochDigits = text.match(/\|\s*(\d{10,13})\b/)?.[1];
  if (epochDigits) {
    const raw = Number(epochDigits);
    if (Number.isFinite(raw)) {
      const epochMs = epochDigits.length > 10 ? raw : raw * 1000;
      return new Date(epochMs);
    }
  }

  const resetText = text.match(/resets?\s+(?:at\s+|on\s+)?(.+)$/i)?.[1];
  if (resetText) {
    const parsed = Date.parse(resetText.trim());
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }

  return undefined;
}

/** Finds limit-hit text on the message shapes it's known to appear on: assistant text blocks, and error-result `errors[]`. */
export function findLimitText(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const content = message.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
          const text = (block as { text: string }).text;
          if (USAGE_LIMIT_PATTERN.test(text)) return text;
        }
      }
    }
  }
  if (message.type === "result" && message.subtype !== "success") {
    const errors = (message as { errors?: string[] }).errors;
    return errors?.find((e) => USAGE_LIMIT_PATTERN.test(e));
  }
  return undefined;
}

export class WorkerSession {
  readonly abortController = new AbortController();
  private readonly input = new MessageQueue<SDKUserMessage>();
  private readonly iterator: AsyncIterator<SDKMessage>;
  private readonly kind: SessionKind;
  sessionId?: string;
  costUsd = 0;
  model?: string;
  modelUsage?: Record<string, ModelUsageSummary>;

  constructor(
    private readonly opts: {
      project: ProjectConfig;
      scope: string;
      worktreePath: string;
      journal: Journal;
      onActivity: (note?: string) => void;
      canUseTool: CanUseTool;
      claudeExecutable?: string;
      resumeSessionId?: string;
      model?: string;
      kind?: SessionKind;
    },
  ) {
    this.kind = opts.kind ?? "code";
    const q = query({
      prompt: this.input,
      options: {
        cwd: opts.worktreePath,
        model: opts.model ?? opts.project.model,
        abortController: this.abortController,
        pathToClaudeCodeExecutable: opts.claudeExecutable,
        resume: opts.resumeSessionId,
        permissionMode: "acceptEdits",
        allowedTools: opts.project.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
        canUseTool: opts.canUseTool,
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [this.kind === "plan" ? denyForbiddenPlanBash : denyForbiddenBash] }] },
        settingSources: ["project"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: this.kind === "plan" ? PLANNER_CONTRACT : WORKER_CONTRACT,
        },
        outputFormat: {
          type: "json_schema",
          schema: this.kind === "plan" ? PLAN_OUTPUT_SCHEMA : WORKER_OUTPUT_SCHEMA,
        },
      },
    });
    this.iterator = q[Symbol.asyncIterator]();
    this.sessionId = opts.resumeSessionId;
  }

  send(text: string): void {
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    });
  }

  async nextResult(timeoutMs: number): Promise<TurnResult> {
    const timer = setTimeout(() => this.abortController.abort(), timeoutMs);
    try {
      for (;;) {
        const { value: message, done } = await this.iterator.next();
        if (done || !message) return { kind: this.kind, errorSubtype: "stream_ended_without_result" } as TurnResult;
        const entry = summarize(message);
        this.opts.onActivity(activityNote(entry));
        this.opts.journal.append(entry);
        if (message.type === "system" && message.subtype === "init") {
          this.sessionId = message.session_id;
          this.model = message.model;
          log("worker", `${this.opts.scope}: session ${this.sessionId} started (${message.model})`);
        }
        if (message.type === "result") {
          this.costUsd = message.total_cost_usd;
          this.modelUsage = summarizeModelUsage(message.modelUsage);
        }
        const limitText = findLimitText(message);
        if (limitText) {
          const limitResetAt = parseLimitReset(limitText);
          log("worker", `${this.opts.scope}: plan usage limit reached${limitResetAt ? ` — resets ${limitResetAt.toISOString()}` : " — no reset time parsed"}`);
          return { kind: this.kind, errorSubtype: "plan_limit", limitResetAt: limitResetAt?.toISOString() } as TurnResult;
        }
        if (message.type === "result") {
          if (message.subtype === "success") {
            const structuredOutput = (message as { structured_output?: unknown }).structured_output;
            if (this.kind === "plan") {
              const parsed = PlanResultSchema.safeParse(structuredOutput);
              if (parsed.success) return { kind: "plan", result: normalizePlanResult(parsed.data) };
              return { kind: "plan", errorSubtype: "invalid_structured_output" };
            }
            const parsed = WorkerResultSchema.safeParse(structuredOutput);
            if (parsed.success) return { kind: "code", result: normalizeResult(parsed.data) };
            return { kind: "code", errorSubtype: "invalid_structured_output" };
          }
          return { kind: this.kind, errorSubtype: message.subtype } as TurnResult;
        }
      }
    } catch (err) {
      if (err instanceof AbortError || this.abortController.signal.aborted) {
        return { kind: this.kind, errorSubtype: `timed out after ${Math.round(timeoutMs / 60_000)} minutes` } as TurnResult;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.input.close();
    const backstop = setTimeout(() => this.abortController.abort(), 10_000);
    backstop.unref?.();
  }
}

export function buildIssuePrompt(project: ProjectConfig, issue: { number: number; title: string; body: string }, comments: string[]): string {
  const parts = [
    `GitHub issue #${issue.number} in ${project.githubRepo}: ${issue.title}`,
    issue.body || "(no description)",
  ];
  if (comments.length > 0) {
    parts.push(`## Discussion on the issue\n\n${comments.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

function activityNote(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "assistant") return undefined;
  const tools = entry.tools as string[] | undefined;
  const text = entry.text as string | undefined;
  if (text && text.trim()) return text.trim().slice(0, 200);
  if (tools && tools.length > 0) return `using ${[...new Set(tools)].join(", ")}`;
  return undefined;
}

export function summarizeModelUsage(
  usage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> | undefined,
): Record<string, ModelUsageSummary> | undefined {
  if (!usage) return undefined;
  const out: Record<string, ModelUsageSummary> = {};
  for (const [model, u] of Object.entries(usage)) {
    out[model] = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUSD };
  }
  return out;
}

/**
 * Models sometimes double-escape newlines in structured output, emitting the
 * literal two-character sequence `\n` where a real newline was meant. Only treat
 * a string as double-escaped when it contains a literal `\n` and no actual
 * newline character — otherwise a summary that legitimately mentions the
 * sequence `\n` (e.g. quoting a code snippet) would be corrupted.
 */
export function looksDoubleEscaped(text: string): boolean {
  return text.includes("\\n") && !text.includes("\n");
}

function unescapeNewlines(text: string): string {
  if (!looksDoubleEscaped(text)) return text;
  return text.replaceAll("\\n", "\n").replaceAll("\\t", "\t");
}

function normalizeResult(result: WorkerResult): WorkerResult {
  return {
    ...result,
    summary: unescapeNewlines(result.summary),
    blockedReason: result.blockedReason ? unescapeNewlines(result.blockedReason) : result.blockedReason,
    prBody: result.prBody ? unescapeNewlines(result.prBody) : result.prBody,
  };
}

function normalizePlanResult(result: PlanResult): PlanResult {
  return {
    ...result,
    summary: unescapeNewlines(result.summary),
    blockedReason: result.blockedReason ? unescapeNewlines(result.blockedReason) : result.blockedReason,
    tickets: result.tickets.map((t) => ({ ...t, body: unescapeNewlines(t.body) })),
  };
}

export function summarize(message: SDKMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { type: message.type };
  if ("subtype" in message) base.subtype = message.subtype;
  if (message.type === "assistant") {
    const content = message.message.content;
    if (Array.isArray(content)) {
      base.text = content
        .filter((block): block is { type: "text"; text: string } =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
        .map((block) => block.text)
        .join("\n")
        .slice(0, 1000);
      const toolUseBlocks = content.filter(
        (block): block is { type: "tool_use"; id: string; name: string; input: unknown } =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use",
      );
      base.tools = toolUseBlocks.map((block) => block.name);
      if (toolUseBlocks.length > 0) {
        base.toolCalls = toolUseBlocks.map((block) => ({
          id: block.id,
          name: block.name,
          input: JSON.stringify(block.input).slice(0, 200),
        }));
      }
    }
  }
  if (message.type === "user") {
    const content = message.message.content;
    if (Array.isArray(content)) {
      const toolResultBlocks = content.filter(
        (block): block is { type: "tool_result"; tool_use_id: string; is_error?: boolean } =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_result",
      );
      if (toolResultBlocks.length > 0) {
        base.toolResults = toolResultBlocks.map((block) => ({
          id: block.tool_use_id,
          isError: block.is_error ?? false,
        }));
      }
    }
  }
  if (message.type === "result") {
    base.costUsd = message.total_cost_usd;
    base.numTurns = message.num_turns;
    base.durationMs = message.duration_ms;
    if (message.subtype === "success") {
      base.structuredOutput = (message as { structured_output?: unknown }).structured_output;
    }
  }
  return base;
}
