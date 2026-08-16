import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { summarize } from "./worker.ts";

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

  it("omits toolCalls when the assistant message has no tool_use blocks", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "just talking" }] },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.tools).toEqual([]);
    expect(result).not.toHaveProperty("toolCalls");
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
});
