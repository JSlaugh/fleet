import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { WorkerResultSchema, type ModelUsageSummary, type ProjectConfig, type WorkerResult } from "@fleet/shared";
import type { Journal } from "./journal.ts";
import { log } from "./log.ts";
import { MessageQueue } from "./queue.ts";

const WORKER_OUTPUT_SCHEMA = z.toJSONSchema(WorkerResultSchema, { target: "draft-7" }) as Record<string, unknown>;

const DEFAULT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "TodoWrite", "Skill", "Agent", "Task"];

const WORKER_CONTRACT = `
You are a fleet worker: an autonomous coding agent handling exactly one GitHub issue in a dedicated git worktree.

Contract:
- Work only within this worktree. The branch already exists and is checked out; never switch branches, never push, and never open PRs — the orchestrator handles those.
- Commit incrementally with clear conventional-commit messages as you complete coherent steps.
- Run the project's own checks (tests, typecheck, lint) before declaring completion when they exist.
- If you hit a decision the issue does not answer, do NOT guess: finish with status "blocked" and put the specific question in blockedReason. A human may answer in a follow-up message — then continue the work.
- Your final structured output: status "completed" requires prTitle and prBody; status "blocked" requires blockedReason.
`.trim();

export interface TurnResult {
  result?: WorkerResult;
  errorSubtype?: string;
}

export class WorkerSession {
  readonly abortController = new AbortController();
  private readonly input = new MessageQueue<SDKUserMessage>();
  private readonly iterator: AsyncIterator<SDKMessage>;
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
    },
  ) {
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
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: WORKER_CONTRACT },
        outputFormat: { type: "json_schema", schema: WORKER_OUTPUT_SCHEMA },
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
        if (done || !message) return { errorSubtype: "stream_ended_without_result" };
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
          if (message.subtype === "success") {
            const parsed = WorkerResultSchema.safeParse(
              (message as { structured_output?: unknown }).structured_output,
            );
            if (parsed.success) return { result: normalizeResult(parsed.data) };
            return { errorSubtype: "invalid_structured_output" };
          }
          return { errorSubtype: message.subtype };
        }
      }
    } catch (err) {
      if (err instanceof AbortError || this.abortController.signal.aborted) {
        return { errorSubtype: `timed out after ${Math.round(timeoutMs / 60_000)} minutes` };
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

function summarizeModelUsage(
  usage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> | undefined,
): Record<string, ModelUsageSummary> | undefined {
  if (!usage) return undefined;
  const out: Record<string, ModelUsageSummary> = {};
  for (const [model, u] of Object.entries(usage)) {
    out[model] = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUSD };
  }
  return out;
}

function unescapeNewlines(text: string): string {
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

function summarize(message: SDKMessage): Record<string, unknown> {
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
      base.tools = content
        .filter((block): block is { type: "tool_use"; name: string } =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use")
        .map((block) => block.name);
    }
  }
  if (message.type === "result") {
    base.costUsd = message.total_cost_usd;
    if (message.subtype === "success") {
      base.structuredOutput = (message as { structured_output?: unknown }).structured_output;
    }
  }
  return base;
}
