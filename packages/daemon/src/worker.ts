import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { WorkerResultSchema, type ProjectConfig, type WorkerResult } from "@fleet/shared";
import type { ReadyIssue } from "./github.ts";
import type { Journal } from "./journal.ts";
import { log } from "./log.ts";

const WORKER_OUTPUT_SCHEMA = z.toJSONSchema(WorkerResultSchema, { target: "draft-7" }) as Record<string, unknown>;

const DEFAULT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "TodoWrite"];

const WORKER_CONTRACT = `
You are a fleet worker: an autonomous coding agent handling exactly one GitHub issue in a dedicated git worktree.

Contract:
- Work only within this worktree. The branch already exists and is checked out; never switch branches, never push, and never open PRs — the orchestrator handles those.
- Commit incrementally with clear conventional-commit messages as you complete coherent steps.
- Run the project's own checks (tests, typecheck, lint) before declaring completion when they exist.
- If you hit a decision the issue does not answer, do NOT guess: finish with status "blocked" and put the specific question in blockedReason.
- Your final structured output: status "completed" requires prTitle and prBody; status "blocked" requires blockedReason.
`.trim();

export interface WorkerRunResult {
  sessionId?: string;
  costUsd: number;
  result?: WorkerResult;
  errorSubtype?: string;
}

export async function runWorker(opts: {
  project: ProjectConfig;
  issue: ReadyIssue;
  comments: string[];
  worktreePath: string;
  journal: Journal;
  onActivity: () => void;
  timeoutMinutes: number;
  claudeExecutable?: string;
}): Promise<WorkerRunResult> {
  const { project, issue, comments, worktreePath, journal, onActivity } = opts;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), opts.timeoutMinutes * 60_000);

  const promptParts = [
    `GitHub issue #${issue.number} in ${project.githubRepo}: ${issue.title}`,
    issue.body || "(no description)",
  ];
  if (comments.length > 0) {
    promptParts.push(`## Discussion on the issue\n\n${comments.join("\n\n")}`);
  }

  const q = query({
    prompt: promptParts.join("\n\n"),
    options: {
      cwd: worktreePath,
      model: project.model,
      abortController,
      pathToClaudeCodeExecutable: opts.claudeExecutable,
      permissionMode: "acceptEdits",
      allowedTools: project.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
      disallowedTools: ["WebFetch", "WebSearch"],
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: WORKER_CONTRACT },
      outputFormat: { type: "json_schema", schema: WORKER_OUTPUT_SCHEMA },
    },
  });

  let sessionId: string | undefined;
  let costUsd = 0;

  try {
    for await (const message of q) {
      onActivity();
      journal.append(summarize(message));
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        log("worker", `${project.name}#${issue.number}: session ${sessionId} started`);
      }
      if (message.type === "result") {
        costUsd = message.total_cost_usd;
        if (message.subtype === "success") {
          const parsed = WorkerResultSchema.safeParse(
            (message as { structured_output?: unknown }).structured_output,
          );
          if (parsed.success) {
            return { sessionId, costUsd, result: parsed.data };
          }
          return { sessionId, costUsd, errorSubtype: "invalid_structured_output" };
        }
        return { sessionId, costUsd, errorSubtype: message.subtype };
      }
    }
    return { sessionId, costUsd, errorSubtype: "stream_ended_without_result" };
  } catch (err) {
    if (err instanceof AbortError || abortController.signal.aborted) {
      return { sessionId, costUsd, errorSubtype: `timed out after ${opts.timeoutMinutes} minutes` };
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
