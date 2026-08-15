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
          { type: "tool_result", tool_use_id: "toolu_1", is_error: true },
          { type: "tool_result", tool_use_id: "toolu_2" },
        ],
      },
    } as unknown as SDKMessage;

    const result = summarize(message);

    expect(result.toolResults).toEqual([
      { id: "toolu_1", isError: true },
      { id: "toolu_2", isError: false },
    ]);
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
