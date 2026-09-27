import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "../test-support.ts";
import { Journal } from "../store/journal.ts";

const queryMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: (opts: unknown) => queryMock(opts) };
});

const { WorkerSession, findEnvironmentRejectionText, isEnvironmentRejectionText } = await import("./worker.ts");
const { runAuthProbe } = await import("./review.ts");

/** The exact text fleet#234's elcSSMS sessions died on. */
const CLI_TOO_OLD = "API Error: 400 Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required.";

function assistantText(text: string, extra: Record<string, unknown> = {}): SDKMessage {
  return { type: "assistant", message: { content: [{ type: "text", text }] }, ...extra } as unknown as SDKMessage;
}

/** Replays `messages` as the `query()` stream, then optionally throws `thenThrow`. */
function streamOf(messages: SDKMessage[], thenThrow?: Error) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
      if (thenThrow) throw thenThrow;
    },
  };
}

beforeEach(() => {
  queryMock.mockReset();
});

describe("isEnvironmentRejectionText", () => {
  it.each([
    CLI_TOO_OLD,
    'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-bogus-9"}}',
    "API Error: 400 invalid model: claude-bogus-9",
    "There's an issue with the selected model (claude-bogus-9). It may not exist or you may not have access to it.",
    `Claude Code process exited: ${CLI_TOO_OLD}`,
  ])("matches %s", (text) => {
    expect(isEnvironmentRejectionText(text)).toBe(true);
  });

  it.each([
    "API Error: 500 Internal server error",
    "API Error: 429 rate limited",
    "API Error: 529 overloaded",
    "Claude Code process exited with code 1",
    "Request timed out",
  ])("does not match the transient/ambiguous %s", (text) => {
    expect(isEnvironmentRejectionText(text)).toBe(false);
  });
});

describe("findEnvironmentRejectionText", () => {
  it("returns the API error text from an assistant text block", () => {
    expect(findEnvironmentRejectionText(assistantText(`  ${CLI_TOO_OLD}  `))).toBe(CLI_TOO_OLD);
  });

  it("does not fire on a worker merely writing about invalid models mid-prose", () => {
    const message = assistantText("I made selectModel reject an invalid model id. For example, API Error: 400 invalid model is what the API returns.");
    expect(findEnvironmentRejectionText(message)).toBeUndefined();
  });

  it("trusts the SDK's structured model_not_found flag even when the text is unrecognised", () => {
    expect(findEnvironmentRejectionText(assistantText("Something went wrong.", { error: "model_not_found" }))).toBe("Something went wrong.");
  });

  it("finds the rejection in an error result's errors[]", () => {
    const message = { type: "result", subtype: "error_during_execution", errors: ["boom", CLI_TOO_OLD] } as unknown as SDKMessage;
    expect(findEnvironmentRejectionText(message)).toBe(CLI_TOO_OLD);
  });
});

describe("WorkerSession.nextResult — environment rejection", () => {
  it("ends the turn as environment_rejected carrying the API error text", async () => {
    queryMock.mockReturnValue(streamOf([assistantText(CLI_TOO_OLD), { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1 } as unknown as SDKMessage]));
    const session = new WorkerSession({
      project: makeProject(),
      scope: "alpha#1",
      worktreePath: "/tmp/wt/1",
      journal: new Journal(mkdtempSync(join(tmpdir(), "fleet-envrejection-")), "alpha", 1),
      onActivity: () => {},
      canUseTool: vi.fn(),
    });

    const turn = await session.nextResult(60_000);

    expect(turn.errorSubtype).toBe("environment_rejected");
    expect(turn.environmentError).toBe(CLI_TOO_OLD);
  });
});

describe("runAuthProbe", () => {
  it("is healthy on a clean one-word reply", async () => {
    queryMock.mockReturnValue(streamOf([assistantText("ok"), { type: "result", subtype: "success" } as unknown as SDKMessage]));
    expect(await runAuthProbe({ model: "claude-sonnet-5" })).toMatchObject({ healthy: true });
  });

  it("is unhealthy, with the API error text, when the model is rejected in the assistant text", async () => {
    queryMock.mockReturnValue(streamOf([assistantText(CLI_TOO_OLD), { type: "result", subtype: "success" } as unknown as SDKMessage]));
    expect(await runAuthProbe({ model: "claude-opus-5-5" })).toEqual({ healthy: false, errorSubtype: "environment_rejected", error: CLI_TOO_OLD });
  });

  it("is unhealthy when the rejection surfaces as a thrown error", async () => {
    queryMock.mockReturnValue(streamOf([], new Error(CLI_TOO_OLD)));
    expect(await runAuthProbe({ model: "claude-opus-5-5" })).toMatchObject({ healthy: false, error: CLI_TOO_OLD });
  });

  it("is unhealthy on a login failure, naming it", async () => {
    queryMock.mockReturnValue(streamOf([assistantText("Failed to authenticate: OAuth session expired")]));
    expect(await runAuthProbe({})).toMatchObject({ healthy: false, errorSubtype: "auth_failed", error: "Failed to authenticate: OAuth session expired" });
  });

  it("fails open on an ambiguous thrown error", async () => {
    queryMock.mockReturnValue(streamOf([], new Error("Claude Code process exited with code 1")));
    expect(await runAuthProbe({})).toMatchObject({ healthy: true });
  });

  it("fails open on a timeout", async () => {
    queryMock.mockImplementation((opts: { options: { abortController: AbortController } }) => ({
      async *[Symbol.asyncIterator]() {
        const { signal } = opts.options.abortController;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        throw new Error("aborted");
      },
    }));
    expect(await runAuthProbe({ timeoutMs: 10 })).toMatchObject({ healthy: true });
  });
});
