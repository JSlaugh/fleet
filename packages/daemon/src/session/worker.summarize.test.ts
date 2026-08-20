import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { shouldJournal, summarize } from "./worker.ts";

describe("summarize", () => {
  it("captures tool_use blocks as toolCalls alongside the existing tools list", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "running a command" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } },
        ],
      },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.tools).toEqual(["Bash"]);
    expect(result.toolCalls).toEqual([
      { id: "toolu_1", name: "Bash", input: JSON.stringify({ command: "ls -la" }) },
    ]);
  });

  it("captures per-message token usage on an assistant entry", () => {
    const message = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        },
      },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 3 });
  });

  it("omits usage when the assistant message carries none", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result).not.toHaveProperty("usage");
  });

  it("captures thinking blocks alongside text", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "let me consider the options", signature: "sig" },
          { type: "text", text: "here's my plan" },
        ],
      },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.thinking).toBe("let me consider the options");
    expect(result.text).toBe("here's my plan");
  });

  it("joins multiple thinking blocks and caps them at 1000 characters", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "a".repeat(700) },
          { type: "thinking", thinking: "b".repeat(700) },
        ],
      },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect((result.thinking as string)).toHaveLength(1000);
    expect((result.thinking as string).startsWith("a".repeat(700))).toBe(true);
  });

  it("omits thinking when the API returns a signature-only block with no text — a legitimate short-thought response, not a capture bug", () => {
    // Content block shape reproduced verbatim from a live probe of the
    // installed SDK (0.1.77) against claude-sonnet-5, from before fleet#177
    // requested `thinking: { display: "summarized" }`. Kept as a fixture: a
    // signature-only block can still occur even with summarized display
    // requested (short pre-tool-call thoughts), so the omit-when-empty
    // handling stays load-bearing.
    const message = {
      type: "assistant",
      message: {
        content: [
          {
            type: "thinking",
            thinking: "",
            signature:
              "ErwCCqUBCBAYAipAytRy9GQ1vPHjoFm1JHCmYxgmkkFoVmUxUh9ND7+B9k+PZefCARfL8ZSNFo0AX8QzJBb2KkznPb9WMMZZJN/MGDIPY2xhdWRlLXNvbm5ldC01OABCCHRoaW5raW5nWiQ2ZTJjZTBiYi03MjBiLTQ3YjYtOTI1Ni05YTU2NjY2MjIxNjVyEIOZX5qpMDF6Ml61A9doNvOIAQGoAdvYmdQGEgxKLQzc",
          },
        ],
      },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result).not.toHaveProperty("thinking");
    expect(result.text).toBe("");
  });

  it("omits thinking but keeps real text when a thinking block is signature-only and a text block on the same message carries content", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "here's my plan" },
        ],
      },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result).not.toHaveProperty("thinking");
    expect(result.text).toBe("here's my plan");
  });

  it("omits thinking when the assistant message has no thinking blocks", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "just talking" }] },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result).not.toHaveProperty("thinking");
  });

  it("omits toolCalls when the assistant message has no tool_use blocks", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "just talking" }] },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.tools).toEqual([]);
    expect(result).not.toHaveProperty("toolCalls");
  });

  // A live probe of the installed SDK found that today, `send()`-pushed text
  // never actually produces a matching `type: "user"` message at all (it
  // reaches the model but isn't echoed) — so pendingSends never matches in
  // practice yet. These cases exercise the matching logic directly so it's
  // correct if/when a future SDK version starts echoing steering back.
  it("captures plain-string user content as text when it matches a pending send — genuine operator/daemon steering", () => {
    const message = {
      type: "user",
      message: { role: "user", content: "please also update the README" },
    } as unknown as SDKMessage;
    const pendingSends = ["please also update the README"];

    const result = summarize(message, { pendingSends });

    expect(result.text).toBe("please also update the README");
    expect(result).not.toHaveProperty("injectedText");
    expect(pendingSends).toEqual([]);
  });

  it("marks plain-string user content as injectedText when it doesn't match a pending send — SDK-injected content like Skill loads", () => {
    const message = {
      type: "user",
      message: { role: "user", content: "Base directory for this skill: /some/path" },
    } as unknown as SDKMessage;

    const result = summarize(message, { pendingSends: ["please also update the README"] });

    expect(result.injectedText).toBe(true);
    expect(result).not.toHaveProperty("text");
  });

  it("marks plain-string user content as injectedText when no pendingSends were tracked at all", () => {
    const message = {
      type: "user",
      message: { role: "user", content: "[structured-output-enforce] You MUST call the StructuredOutput tool" },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.injectedText).toBe(true);
    expect(result).not.toHaveProperty("text");
  });

  it("consumes only the matching head of pendingSends, in order, leaving later pending sends untouched", () => {
    const pendingSends = ["first reply", "second reply"];

    const first = summarize(
      { type: "user", message: { role: "user", content: "first reply" } } as unknown as SDKMessage,
      { pendingSends },
    );
    expect(first.text).toBe("first reply");
    expect(pendingSends).toEqual(["second reply"]);

    const injected = summarize(
      { type: "user", message: { role: "user", content: "some unrelated injected string" } } as unknown as SDKMessage,
      { pendingSends },
    );
    expect(injected.injectedText).toBe(true);
    expect(pendingSends).toEqual(["second reply"]);

    const second = summarize(
      { type: "user", message: { role: "user", content: "second reply" } } as unknown as SDKMessage,
      { pendingSends },
    );
    expect(second.text).toBe("second reply");
    expect(pendingSends).toEqual([]);
  });

  it("omits text for an empty or whitespace-only string user message", () => {
    const message = {
      type: "user",
      message: { role: "user", content: "   " },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("injectedText");
  });

  it("captures text blocks within an array-content user message", () => {
    const message = {
      type: "user",
      message: { content: [{ type: "text", text: "steering via a content block" }] },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.text).toBe("steering via a content block");
  });

  it("captures tool_result blocks, defaulting is_error to false when absent", () => {
    const message = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "boom" },
          { type: "tool_result", tool_use_id: "toolu_2" },
        ],
      },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.toolResults).toEqual([
      { id: "toolu_1", isError: true, outputSize: 4, error: "boom" },
      { id: "toolu_2", isError: false, outputSize: 0 },
    ]);
  });

  it("caps a captured error at 500 characters", () => {
    const message = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "x".repeat(600) }],
      },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect((result.toolResults as { error: string }[])[0]?.error).toHaveLength(500);
  });

  it("extracts tool_result text from an array of text blocks for size and error capture", () => {
    const message = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            is_error: true,
            content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }],
          },
        ],
      },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.toolResults).toEqual([
      { id: "toolu_1", isError: true, outputSize: Buffer.byteLength("line one\nline two", "utf8"), error: "line one\nline two" },
    ]);
  });

  it("attaches a tool result's duration when the matching tool_use was timed earlier", () => {
    const toolTimings = new Map<string, number>();
    const useMessage = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
    } as unknown as SDKMessage;
    summarize(useMessage, { toolTimings, now: 1000 });

    const resultMessage = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
    } as unknown as SDKMessage;
    const result = summarize(resultMessage, { toolTimings, now: 1750 });

    expect(result.toolResults).toEqual([{ id: "toolu_1", isError: false, outputSize: 0, durationMs: 750 }]);
    expect(toolTimings.has("toolu_1")).toBe(false);
  });

  it("omits duration when no matching tool_use was timed", () => {
    const message = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_unknown" }] },
    } as unknown as SDKMessage;

    const result = summarize(message, { toolTimings: new Map() });

    expect(result.toolResults).toEqual([{ id: "toolu_unknown", isError: false, outputSize: 0 }]);
  });

  it("omits toolResults when the user message has no tool_result blocks", () => {
    const message = {
      type: "user",
      message: { content: [] },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result).not.toHaveProperty("toolResults");
  });

  it("copies numTurns and durationMs through for a success result", () => {
    const message = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.5,
      num_turns: 7,
      duration_ms: 12345,
      structured_output: { status: "completed" },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.costUsd).toBe(0.5);
    expect(result.numTurns).toBe(7);
    expect(result.durationMs).toBe(12345);
    expect(result.structuredOutput).toEqual({ status: "completed" });
  });

  it("copies numTurns and durationMs through for an error result", () => {
    const message = {
      type: "result",
      subtype: "error_max_turns",
      total_cost_usd: 1.2,
      num_turns: 42,
      duration_ms: 99999,
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.costUsd).toBe(1.2);
    expect(result.numTurns).toBe(42);
    expect(result.durationMs).toBe(99999);
    expect(result).not.toHaveProperty("structuredOutput");
  });

  it("captures a result message's terminal_reason", () => {
    const message = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.5,
      num_turns: 7,
      duration_ms: 12345,
      terminal_reason: "completed",
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.terminalReason).toBe("completed");
  });

  it("omits terminalReason when a result carries none", () => {
    const message = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.5,
      num_turns: 7,
      duration_ms: 12345,
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result).not.toHaveProperty("terminalReason");
  });

  it("summarizes a result's permission_denials as tool name -> count", () => {
    const message = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.5,
      num_turns: 7,
      duration_ms: 12345,
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: {} },
        { tool_name: "Bash", tool_use_id: "toolu_2", tool_input: {} },
        { tool_name: "WebFetch", tool_use_id: "toolu_3", tool_input: {} },
      ],
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.permissionDenials).toEqual({ Bash: 2, WebFetch: 1 });
  });

  it("omits permissionDenials when a result carries none", () => {
    const message = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.5,
      num_turns: 7,
      duration_ms: 12345,
      permission_denials: [],
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result).not.toHaveProperty("permissionDenials");
  });

  it("captures a rate_limit_event's status, type, utilization, and resetsAt for journaling", () => {
    const message = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: 1735689600 },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.rateLimitInfo).toEqual({
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: 1735689600,
    });
  });

  it("captures a rate_limit_event with only status set", () => {
    const message = {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning" },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.rateLimitInfo).toEqual({
      status: "allowed_warning",
      rateLimitType: undefined,
      utilization: undefined,
      resetsAt: undefined,
    });
  });
});

describe("shouldJournal", () => {
  it.each(["assistant", "user", "result", "rate_limit_event"])("journals a %s message", (type) => {
    expect(shouldJournal({ type } as unknown as SDKMessage)).toBe(true);
  });

  it.each(["init", "api_retry"])("journals a system message with subtype %s", (subtype) => {
    expect(shouldJournal({ type: "system", subtype } as unknown as SDKMessage)).toBe(true);
  });

  it.each([
    "status",
    "compact_boundary",
    "hook_started",
    "task_notification",
    "permission_denied",
    "thinking_tokens",
  ])("drops a system message with subtype %s — no journal-worth content", (subtype) => {
    expect(shouldJournal({ type: "system", subtype } as unknown as SDKMessage)).toBe(false);
  });

  it.each(["stream_event", "tool_progress", "auth_status", "tool_use_summary", "prompt_suggestion", "conversation_reset"])(
    "drops a %s message — new-in-0.3.x noise summarize() has no branch for",
    (type) => {
      expect(shouldJournal({ type } as unknown as SDKMessage)).toBe(false);
    },
  );
});
