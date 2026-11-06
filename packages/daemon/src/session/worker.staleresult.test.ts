import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "../test-support.ts";
import { Journal, readJournalTail } from "../store/journal.ts";
import type { SessionKind } from "./worker.ts";

const queryMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: (opts: unknown) => queryMock(opts) };
});

const { WorkerSession, isStaleResult } = await import("./worker.ts");

/** A fixed SDK message stream; reads past the end hang, like a live CLI that hasn't spoken yet. */
function makeSession(messages: SDKMessage[], kind: SessionKind = "code") {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-stale-"));
  const journal = new Journal(dataDir, "alpha", 1);
  let prompt: { close: () => void } | undefined;
  queryMock.mockImplementation((opts: { prompt: { close: () => void } }) => {
    prompt = opts.prompt;
    const queued = [...messages];
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const value = queued.shift();
          return value ? Promise.resolve({ value, done: false }) : new Promise(() => {});
        },
      }),
    };
  });
  const session = new WorkerSession({
    project: makeProject(),
    scope: "alpha#1",
    worktreePath: "/tmp/wt/1",
    journal,
    onActivity: () => {},
    canUseTool: vi.fn(),
    kind,
  });
  return { session, dataDir, prompt: prompt! };
}

function result(patch: Record<string, unknown>): SDKMessage {
  return { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 0, duration_ms: 120, ...patch } as unknown as SDKMessage;
}

const staleResult = result({});
const codeResult = result({
  total_cost_usd: 0.4,
  num_turns: 6,
  structured_output: { status: "completed", summary: "Addressed the review.", filesChanged: [], confidence: "high", prTitle: "fix: x", prBody: "y" },
});
const planResult = result({
  num_turns: 3,
  structured_output: { status: "completed", summary: "Split it.", confidence: "high", tickets: [{ title: "a", body: "b" }] },
});

beforeEach(() => {
  queryMock.mockReset();
});

describe("isStaleResult", () => {
  it.each([
    { name: "0 turns, no structured output", message: staleResult, stale: true },
    { name: "0 turns, null structured output", message: result({ structured_output: null }), stale: true },
    { name: "real turns", message: result({ num_turns: 2 }), stale: false },
    { name: "0 turns but a structured output", message: result({ structured_output: { status: "blocked" } }), stale: false },
    { name: "an error result", message: result({ subtype: "error_during_execution", errors: [] }), stale: false },
  ])("$name → $stale", ({ message, stale }) => {
    expect(isStaleResult(message as Extract<SDKMessage, { type: "result" }>)).toBe(stale);
  });
});

describe("WorkerSession — stale replay results on resume (fleet#238)", () => {
  it("skips a 0-turn result with no structured output and returns the real one after it", async () => {
    const { session, dataDir } = makeSession([staleResult, codeResult]);

    const turn = await session.nextResult(60_000);

    expect(turn.errorSubtype).toBeUndefined();
    expect(turn.result?.status).toBe("completed");
    expect(session.numTurns).toBe(6);
    expect(readJournalTail(dataDir, "alpha", 1, 50).some((e) => e.event === "stale-result-ignored")).toBe(true);
  });

  it("applies the same rule to plan sessions", async () => {
    const { session } = makeSession([staleResult, planResult], "plan");

    const turn = await session.nextResult(60_000);

    expect(turn.kind).toBe("plan");
    expect(turn.result?.status).toBe("completed");
  });
});

describe("WorkerSession.close — no live session left without its permission callback", () => {
  it("aborts the CLI before closing its input when the last turn failed", async () => {
    const { session, prompt } = makeSession([result({ num_turns: 4 })]);
    let abortedWhenInputClosed: boolean | undefined;
    const close = prompt.close.bind(prompt);
    prompt.close = () => {
      abortedWhenInputClosed = session.abortController.signal.aborted;
      close();
    };

    const turn = await session.nextResult(60_000);
    session.close();

    expect(turn.errorSubtype).toBe("invalid_structured_output");
    expect(abortedWhenInputClosed).toBe(true);
  });

  it("closes gently after a turn that ended on a valid result", async () => {
    const { session } = makeSession([codeResult]);

    await session.nextResult(60_000);
    session.close();

    expect(session.abortController.signal.aborted).toBe(false);
  });
});
