import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { checkAuthFailure, findAuthFailureText } from "./worker.ts";

describe("findAuthFailureText", () => {
  it("matches the CLI's own auth-failure message on an assistant text block", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] },
    } as unknown as SDKMessage;

    expect(findAuthFailureText(message)).toBe("Failed to authenticate: OAuth session expired and could not be refreshed");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "  failed TO AUTHENTICATE: token invalid  " }] },
    } as unknown as SDKMessage;

    expect(findAuthFailureText(message)).toBe("failed TO AUTHENTICATE: token invalid");
  });

  it("does not fire on a normal turn that merely discusses authentication", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "I updated the JWT middleware. When a client fails to authenticate, we now return 401 with a clear error instead of a 500.",
          },
        ],
      },
    } as unknown as SDKMessage;

    expect(findAuthFailureText(message)).toBeUndefined();
  });

  it("does not fire on unrelated assistant text", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Running the test suite now." }] },
    } as unknown as SDKMessage;

    expect(findAuthFailureText(message)).toBeUndefined();
  });

  it("ignores non-assistant message types", () => {
    const message = {
      type: "result",
      subtype: "success",
      errors: ["Failed to authenticate: OAuth session expired and could not be refreshed"],
    } as unknown as SDKMessage;

    expect(findAuthFailureText(message)).toBeUndefined();
  });

  it("ignores an assistant message with no text content blocks", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "1", name: "Read", input: {} }] },
    } as unknown as SDKMessage;

    expect(findAuthFailureText(message)).toBeUndefined();
  });
});

describe("checkAuthFailure", () => {
  it("reports true for the CLI's auth-failure text", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] },
    } as unknown as SDKMessage;

    expect(checkAuthFailure(message)).toBe(true);
  });

  it("reports false for a session that merely mentions authentication in its output", () => {
    const message = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Added tests covering the case where a user fails to authenticate with an expired token." }],
      },
    } as unknown as SDKMessage;

    expect(checkAuthFailure(message)).toBe(false);
  });
});
