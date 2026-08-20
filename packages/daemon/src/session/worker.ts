import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, HookCallback, SDKMessage, SDKPermissionDenial, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  PlanResultSchema,
  WorkerResultSchema,
  type Effort,
  type ModelUsageSummary,
  type PlanResult,
  type ProjectConfig,
  type TicketRecord,
  type WorkerResult,
} from "@fleet/shared";
import type { Journal } from "../store/journal.ts";
import { log } from "../log.ts";
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
- If a child genuinely can't be implemented before another lands (e.g. "use the schema field" needs "add the schema field" first), set that child's dependsOnIndex to the 0-based index of the sibling(s) it depends on in tickets[] — sparingly, and only pointing at an earlier index (a later or self index is dropped).
- If the epic is too ambiguous to decompose confidently, do NOT guess: finish with status "blocked" and put the specific question in blockedReason.
- Your final structured output lists every proposed child ticket in tickets[].
`.trim();

/**
 * The system prompt appendix for one session: the fixed per-kind contract,
 * plus (code sessions only) the claimed ticket's type-specific `contract:`
 * markdown and `verify:` commands, if its `fleet.yaml` profile declares them.
 * Pulled out as a pure function so the appendix text is unit-testable without
 * spinning up the SDK `query()` call the constructor makes. A planner never
 * gets a type appendix — a read-only decomposition pass doesn't write code to
 * verify.
 */
export function buildSystemPromptAppend(kind: SessionKind, typeContract?: string, verifyCommands?: string[]): string {
  const base = kind === "plan" ? PLANNER_CONTRACT : WORKER_CONTRACT;
  if (kind === "plan") return base;
  const parts = [base];
  if (typeContract) parts.push(typeContract);
  if (verifyCommands && verifyCommands.length > 0) {
    parts.push(
      [
        "## Required verification for this ticket type",
        "",
        `This ticket's type requires the following commands to pass before you finish with status "completed":`,
        ...verifyCommands.map((c) => `- \`${c}\``),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

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

/**
 * Wraps `denyForbiddenBash`/`denyForbiddenPlanBash` so a denial also lands a
 * `type: "fleet"` journal event — a worker reaching for `git push`/`gh pr` is a
 * strong off-contract signal, and the pure guards above have no journal to
 * write to. Kept as a wrapper (rather than folding logging into the guards
 * themselves) so `worker.guard.test.ts` keeps testing the guards as plain,
 * journal-free functions.
 */
export function makeJournaledBashGuard(guard: HookCallback, journal: Journal): HookCallback {
  return async (input, toolUseId, options) => {
    const result = await guard(input, toolUseId, options);
    const hookSpecificOutput = (result as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } })
      .hookSpecificOutput;
    if (hookSpecificOutput?.permissionDecision === "deny") {
      const command = (input as { tool_input?: { command?: unknown } }).tool_input?.command;
      journal.append({
        type: "fleet",
        event: "bash-denied",
        command: typeof command === "string" ? command.slice(0, 500) : undefined,
        reason: hookSpecificOutput.permissionDecisionReason,
      });
    }
    return result;
  };
}

export interface CodeTurnResult {
  kind: "code";
  result?: WorkerResult;
  errorSubtype?: string;
  /** Set alongside `errorSubtype: "plan_limit"` when a reset time could be parsed out of the limit message. */
  limitResetAt?: string;
  /** The SDK result message's `terminal_reason`, when the turn ended on a `result` message — richer than `errorSubtype` alone for diagnosing why a turn ended. */
  terminalReason?: string;
}

export interface PlanTurnResult {
  kind: "plan";
  result?: PlanResult;
  errorSubtype?: string;
  limitResetAt?: string;
  terminalReason?: string;
}

export type TurnResult = CodeTurnResult | PlanTurnResult;

/** The error text `finishFailed` reports for a turn that didn't complete — `errorSubtype` plus `terminalReason` when the SDK supplied one, so "why did this turn end" isn't guessed from subtype alone. */
export function formatTurnError(turn: { errorSubtype?: string; terminalReason?: string }): string {
  const subtype = turn.errorSubtype ?? "unknown error";
  return turn.terminalReason ? `${subtype} (terminal_reason: ${turn.terminalReason})` : subtype;
}

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
    return message.errors.find((e) => USAGE_LIMIT_PATTERN.test(e));
  }
  return undefined;
}

/**
 * The one signal `WorkerSession.nextResult`/`runReviewSession` act on for a plan
 * usage-limit hit: the SDK's structured `rate_limit_event` (`status: "rejected"`,
 * added in the SDK bump for fleet#177) when present, falling back to the older
 * `findLimitText`/`parseLimitReset` text heuristic otherwise. A `rate_limit_event`
 * and a legacy text match can never both fire off the *same* message — they key off
 * disjoint `message.type`s — so a caller that returns as soon as this returns
 * non-undefined can't double-report one limit hit, even across a stream where both
 * signals eventually appear.
 */
export function checkPlanLimit(message: SDKMessage): { limitResetAt?: Date } | undefined {
  if (message.type === "rate_limit_event") {
    if (message.rate_limit_info.status !== "rejected") return undefined;
    const resetsAt = message.rate_limit_info.resetsAt;
    return { limitResetAt: resetsAt !== undefined ? new Date(resetsAt * 1000) : undefined };
  }
  const limitText = findLimitText(message);
  if (!limitText) return undefined;
  return { limitResetAt: parseLimitReset(limitText) };
}

/** `SDKMessage["type"]`s `summarize()` extracts real content for. */
const JOURNALED_MESSAGE_TYPES = new Set<string>(["assistant", "user", "result", "rate_limit_event"]);

/**
 * `system` messages worth a journal row even though `summarize()` has no
 * dedicated branch for them and would otherwise produce a bare
 * `{type, subtype}` row: `init` carries the session id `nextResult` reads out
 * of it, and `api_retry` is a genuine diagnostic signal (a request retried).
 */
const JOURNALED_SYSTEM_SUBTYPES = new Set<string>(["init", "api_retry"]);

/**
 * Whether a message is worth a journal row at all. The SDK's `SDKMessage`
 * union grew from ~6 to ~39 members in 0.3.x (`tool_progress`,
 * `thinking_tokens`, `status`, `hook_started`, task/notification events, ...)
 * — `summarize()` has no branch for almost all of them, so left unguarded
 * they'd journal as bare `{type: "..."}` noise, and `journal_entries` has no
 * retention policy to age it back out. Kept as an explicit allowlist (types
 * `summarize()` actually extracts content for, plus the two `system`
 * subtypes above) rather than a blocklist, so a *future* SDK message type
 * defaults to being dropped instead of silently journaling noise again.
 */
export function shouldJournal(message: SDKMessage): boolean {
  if (message.type === "system") return JOURNALED_SYSTEM_SUBTYPES.has(message.subtype);
  return JOURNALED_MESSAGE_TYPES.has(message.type);
}

/** The on-disk transcript title for a session, so `claude --resume`/the transcripts directory can identify it at a glance. `suffix` distinguishes a review pass from the worker session it reviews. */
export function sessionTitle(scope: string, suffix?: string): string {
  return suffix ? `fleet ${scope} ${suffix}` : `fleet ${scope}`;
}

export class WorkerSession {
  readonly abortController = new AbortController();
  private readonly input = new MessageQueue<SDKUserMessage>();
  private readonly iterator: AsyncIterator<SDKMessage>;
  private readonly kind: SessionKind;
  private readonly toolTimings: ToolTimings = new Map();
  /**
   * FIFO of texts pushed via `send()`, not yet observed echoed back through
   * the message stream. Ground truth for which `type: "user"` plain-string
   * messages are genuine operator/daemon steering versus SDK-injected content
   * (skill loads, structured-output enforcement) — `summarize()` consumes it
   * to tell the two apart instead of assuming every plain string is ours.
   *
   * Verified against a live probe of the installed SDK (0.1.77, streaming
   * `prompt` input, claude-sonnet-5): a mid-session `send()`-equivalent push
   * reaches the model (the next turn's reply reflected it) but never once
   * produces a `type: "user"` message in the output iterator to match
   * against — so today this queue never actually finds a match, and every
   * observed plain-string "user" message really is SDK-injected. That's not
   * a bug in the matching; it's this SDK version's behavior. Kept as the
   * correct ground-truth mechanism (not content-sniffing) in case a future
   * SDK version starts echoing steering back.
   */
  private readonly pendingSends: string[] = [];
  sessionId?: string;
  costUsd = 0;
  model?: string;
  modelUsage?: Record<string, ModelUsageSummary>;
  readonly effort?: Effort;

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
      /** Reasoning effort for this session — see `selectEffort` in loop/runner.ts. Unset leaves the SDK's own default in place. */
      effort?: Effort;
      kind?: SessionKind;
      /** The claimed ticket's type-specific `contract:` markdown, if any — see `buildSystemPromptAppend`. */
      contract?: string;
      /** The claimed ticket's type-specific `verify:` commands, if any — see `buildSystemPromptAppend`. */
      verify?: string[];
    },
  ) {
    this.kind = opts.kind ?? "code";
    this.effort = opts.effort;
    const q = query({
      prompt: this.input,
      options: {
        cwd: opts.worktreePath,
        model: opts.model ?? opts.project.model,
        effort: opts.effort,
        abortController: this.abortController,
        pathToClaudeCodeExecutable: opts.claudeExecutable,
        resume: opts.resumeSessionId,
        // On resume the persisted title wins — this only names a fresh transcript.
        title: sessionTitle(opts.scope),
        permissionMode: "acceptEdits",
        allowedTools: opts.project.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
        canUseTool: opts.canUseTool,
        hooks: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [makeJournaledBashGuard(this.kind === "plan" ? denyForbiddenPlanBash : denyForbiddenBash, opts.journal)],
          }],
        },
        settingSources: ["project"],
        thinking: { type: "adaptive", display: "summarized" },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildSystemPromptAppend(this.kind, opts.contract, opts.verify),
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
    this.pendingSends.push(text);
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    });
  }

  async nextResult(timeoutMs: number): Promise<TurnResult> {
    const timer = setTimeout(() => this.abortController.abort(), timeoutMs);
    try {
      for (;;) {
        const { value: message, done } = await this.iterator.next();
        if (done || !message) return { kind: this.kind, errorSubtype: "stream_ended_without_result" } as TurnResult;
        if (shouldJournal(message)) {
          const entry = summarize(message, { toolTimings: this.toolTimings, pendingSends: this.pendingSends });
          this.opts.onActivity(activityNote(entry));
          this.opts.journal.append(entry);
        }
        if (message.type === "system" && message.subtype === "init") {
          this.sessionId = message.session_id;
          this.model = message.model;
          log("worker", `${this.opts.scope}: session ${this.sessionId} started (${message.model}${this.effort ? `, effort ${this.effort}` : ""})`);
          this.opts.journal.append({ type: "fleet", event: "session-started", model: message.model, effort: this.effort });
        }
        if (message.type === "result") {
          this.costUsd = message.total_cost_usd;
          this.modelUsage = summarizeModelUsage(message.modelUsage);
        }
        const planLimit = checkPlanLimit(message);
        if (planLimit) {
          const { limitResetAt } = planLimit;
          log("worker", `${this.opts.scope}: plan usage limit reached${limitResetAt ? ` — resets ${limitResetAt.toISOString()}` : " — no reset time parsed"}`);
          return { kind: this.kind, errorSubtype: "plan_limit", limitResetAt: limitResetAt?.toISOString() } as TurnResult;
        }
        if (message.type === "result") {
          if (message.subtype === "success") {
            const structuredOutput = message.structured_output;
            if (this.kind === "plan") {
              const parsed = PlanResultSchema.safeParse(structuredOutput);
              if (parsed.success) return { kind: "plan", result: normalizePlanResult(parsed.data) };
              return { kind: "plan", errorSubtype: "invalid_structured_output", terminalReason: message.terminal_reason };
            }
            const parsed = WorkerResultSchema.safeParse(structuredOutput);
            if (parsed.success) return { kind: "code", result: normalizeResult(parsed.data) };
            return { kind: "code", errorSubtype: "invalid_structured_output", terminalReason: message.terminal_reason };
          }
          return { kind: this.kind, errorSubtype: message.subtype, terminalReason: message.terminal_reason } as TurnResult;
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

/** Chars of an epic body quoted into a child's framing block — enough for context, capped so a huge epic body can't dominate the prompt. */
const EPIC_CONTEXT_BODY_CHARS = 500;

/**
 * The framing block prepended to a child ticket's prompt when its body
 * carries a `Part-of: #<epic>` line: the epic's title, an excerpt of its
 * body, and — when the epic's own `## Children` task list can place this
 * ticket in it — this ticket's position among its siblings.
 */
export function buildEpicContextBlock(
  epic: { number: number; title: string; body: string },
  position?: { index: number; total: number },
): string {
  const positionNote = position ? ` — ticket ${position.index} of ${position.total}` : "";
  const bodyExcerpt = epic.body.trim().slice(0, EPIC_CONTEXT_BODY_CHARS);
  return [
    `## Part of epic #${epic.number}`,
    `This ticket is part of epic #${epic.number}: ${epic.title}${positionNote}.`,
    bodyExcerpt,
  ].filter(Boolean).join("\n\n");
}

/** Chars of a prior attempt's summary/failure reason folded into the next session's prompt — capped so a pathological history can't blow up the prompt. */
const PRIOR_ATTEMPT_CHARS = 1000;

/**
 * The framing block prepended to a ticket's first prompt when a previous
 * attempt already ran against it — its closing summary or failure reason, so
 * a restart or a post-failure re-claim isn't flying blind on what already
 * happened. Prefers `priorAttemptSummary` (the pre-restart value
 * `resetForFreshClaim` preserves before overwriting `lastSummary` with
 * restart boilerplate) and falls back to `lastSummary` itself, which already
 * holds the real failure reason for a plain failed/auto-elevated re-claim.
 * Undefined for a genuinely first attempt, so a fresh ticket's prompt is
 * unchanged.
 */
export function buildPriorAttemptBlock(
  record: Pick<TicketRecord, "lastSummary" | "priorAttemptSummary"> | undefined,
): string | undefined {
  const text = record?.priorAttemptSummary ?? record?.lastSummary;
  if (!text) return undefined;
  return [
    `## Prior attempt`,
    `A previous attempt on this issue did not finish. What it reported:`,
    text.slice(0, PRIOR_ATTEMPT_CHARS),
  ].join("\n\n");
}

export function buildIssuePrompt(
  project: ProjectConfig,
  issue: { number: number; title: string; body: string },
  comments: string[],
  epicContext?: string,
  priorAttempt?: string,
): string {
  const parts: string[] = [];
  if (priorAttempt) parts.push(priorAttempt);
  if (epicContext) parts.push(epicContext);
  parts.push(
    `GitHub issue #${issue.number} in ${project.githubRepo}: ${issue.title}`,
    issue.body || "(no description)",
  );
  if (comments.length > 0) {
    parts.push(`## Discussion on the issue\n\n${comments.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

export function activityNote(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "assistant") return undefined;
  const tools = entry.tools as string[] | undefined;
  const text = entry.text as string | undefined;
  if (text && text.trim()) return text.trim().slice(0, 200);
  if (tools && tools.length > 0) return `using ${[...new Set(tools)].join(", ")}`;
  return undefined;
}

export function summarizeModelUsage(
  usage:
    | Record<
        string,
        { inputTokens: number; outputTokens: number; costUSD: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
      >
    | undefined,
): Record<string, ModelUsageSummary> | undefined {
  if (!usage) return undefined;
  const out: Record<string, ModelUsageSummary> = {};
  for (const [model, u] of Object.entries(usage)) {
    out[model] = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      costUsd: u.costUSD,
      cacheReadTokens: u.cacheReadInputTokens ?? 0,
      cacheCreationTokens: u.cacheCreationInputTokens ?? 0,
    };
  }
  return out;
}

/** Tool name → count, for the result journal entry — cross-checks the existing `bash-denied` fleet events without repeating every denial's full tool_input. */
export function summarizePermissionDenials(denials: SDKPermissionDenial[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const denial of denials) counts[denial.tool_name] = (counts[denial.tool_name] ?? 0) + 1;
  return counts;
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

/** The first ~500 chars of a tool result's error text, capped so a runaway stack trace can't blow up the journal. */
const TOOL_ERROR_CHAR_LIMIT = 500;

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Mutable per-session state `summarize` uses to attach a tool result's
 * wall-clock duration: the timestamp of its matching `tool_use` block, keyed
 * by tool_use id, recorded when that block is summarized and consumed (and
 * removed) when the matching `tool_result` arrives. Owned by the caller
 * (`WorkerSession`/`runMachineReview`) so it spans the whole message stream;
 * `summarize` itself stays a pure function of its arguments.
 */
export type ToolTimings = Map<string, number>;

export function summarize(
  message: SDKMessage,
  opts: { toolTimings?: ToolTimings; now?: number; pendingSends?: string[] } = {},
): Record<string, unknown> {
  const now = opts.now ?? Date.now();
  const base: Record<string, unknown> = { type: message.type };
  if ("subtype" in message) base.subtype = message.subtype;
  if (message.type === "assistant") {
    const content = message.message.content as unknown[];
    const usage = (message.message as unknown as { usage?: Record<string, unknown> }).usage;
    if (usage) {
      base.usage = {
        inputTokens: usage.input_tokens as number | undefined,
        outputTokens: usage.output_tokens as number | undefined,
        cacheReadTokens: usage.cache_read_input_tokens as number | undefined,
        cacheCreationTokens: usage.cache_creation_input_tokens as number | undefined,
      };
    }
    if (Array.isArray(content)) {
      base.text = content
        .filter((block): block is { type: "text"; text: string } =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
        .map((block) => block.text)
        .join("\n")
        .slice(0, 1000);
      const thinkingBlocks = content.filter(
        (block): block is { type: "thinking"; thinking: string } =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "thinking",
      );
      if (thinkingBlocks.length > 0) {
        // `query()` requests `thinking: { type: "adaptive", display: "summarized" }`
        // (worker.ts constructor / review.ts runReviewSession — see fleet#177), but a
        // present-but-empty `thinking` string (only `signature` populated) is still a
        // legitimate response rather than a capture bug: short pre-tool-call thoughts
        // can come back signature-only even with summarized display requested. Only
        // attach the field when there's real text to show.
        const thinkingText = thinkingBlocks.map((block) => block.thinking).join("\n").slice(0, 1000);
        if (thinkingText.trim()) base.thinking = thinkingText;
      }
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
        if (opts.toolTimings) {
          for (const block of toolUseBlocks) opts.toolTimings.set(block.id, now);
        }
      }
    }
  }
  if (message.type === "user") {
    const content = message.message.content as unknown;
    // Plain-string "user" messages aren't necessarily operator/daemon
    // steering: the SDK also injects its own strings this way (Skill content
    // loads, structured-output enforcement). `pendingSends` is the ground
    // truth for what `session.send()` actually pushed — match against it
    // instead of trusting message content, which is fragile and would let
    // SDK-injected text masquerade as operator steering.
    if (typeof content === "string") {
      if (content.trim()) {
        const pending = opts.pendingSends;
        if (pending && pending[0] === content) {
          pending.shift();
          base.text = content.slice(0, 1000);
        } else {
          base.injectedText = true;
        }
      }
    } else if (Array.isArray(content)) {
      const textBlocks = content.filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
      );
      if (textBlocks.length > 0) {
        base.text = textBlocks.map((block) => block.text).join("\n").slice(0, 1000);
      }
      const toolResultBlocks = content.filter(
        (block): block is { type: "tool_result"; tool_use_id: string; is_error?: boolean; content?: unknown } =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_result",
      );
      if (toolResultBlocks.length > 0) {
        base.toolResults = toolResultBlocks.map((block) => {
          const text = extractToolResultText(block.content);
          const isError = block.is_error ?? false;
          const result: Record<string, unknown> = {
            id: block.tool_use_id,
            isError,
            outputSize: Buffer.byteLength(text, "utf8"),
          };
          const startedAt = opts.toolTimings?.get(block.tool_use_id);
          if (startedAt !== undefined) {
            result.durationMs = now - startedAt;
            opts.toolTimings?.delete(block.tool_use_id);
          }
          if (isError) result.error = text.slice(0, TOOL_ERROR_CHAR_LIMIT);
          return result;
        });
      }
    }
  }
  if (message.type === "result") {
    base.costUsd = message.total_cost_usd;
    base.numTurns = message.num_turns;
    base.durationMs = message.duration_ms;
    if (message.subtype === "success") {
      base.structuredOutput = message.structured_output;
    }
    if (message.terminal_reason) base.terminalReason = message.terminal_reason;
    if (message.permission_denials && message.permission_denials.length > 0) {
      base.permissionDenials = summarizePermissionDenials(message.permission_denials);
    }
  }
  if (message.type === "rate_limit_event") {
    const info = message.rate_limit_info;
    base.rateLimitInfo = {
      status: info.status,
      rateLimitType: info.rateLimitType,
      utilization: info.utilization,
      resetsAt: info.resetsAt,
    };
  }
  return base;
}
