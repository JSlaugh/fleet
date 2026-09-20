import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "../test-support.ts";
import { Journal } from "../store/journal.ts";

const queryMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: (opts: unknown) => queryMock(opts) };
});

const { WorkerSession } = await import("./worker.ts");

/**
 * A hand-rolled async-iterable message stream standing in for the SDK's real
 * `query()` return value — `WorkerSession` only ever consumes it through
 * `[Symbol.asyncIterator]().next()`, so this is enough to drive `nextResult`
 * without spinning up the actual CLI subprocess. Wired to the same
 * `abortController` the session passes to `query()`, since a real `query()`
 * stream rejects in-flight reads once its abort signal fires — that's the
 * mechanism `nextResult` actually relies on to notice a turn-clock expiry.
 */
function makeControlledStream(signal: AbortSignal) {
  const queued: SDKMessage[] = [];
  let waiting: { resolve: (result: IteratorResult<SDKMessage>) => void; reject: (err: unknown) => void } | undefined;
  signal.addEventListener("abort", () => {
    if (!waiting) return;
    const { reject } = waiting;
    waiting = undefined;
    reject(new Error("aborted"));
  });
  return {
    push(message: SDKMessage): void {
      if (waiting) {
        const { resolve } = waiting;
        waiting = undefined;
        resolve({ value: message, done: false });
      } else {
        queued.push(message);
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKMessage>> {
          const next = queued.shift();
          if (next) return Promise.resolve({ value: next, done: false });
          if (signal.aborted) return Promise.reject(new Error("aborted"));
          return new Promise((resolve, reject) => {
            waiting = { resolve, reject };
          });
        },
      };
    },
  };
}

function makeSession() {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-turnclock-"));
  const journal = new Journal(dataDir, "alpha", 1);
  let stream: ReturnType<typeof makeControlledStream> | undefined;
  queryMock.mockImplementation((opts: { options?: { abortController?: AbortController } }) => {
    stream = makeControlledStream(opts.options!.abortController!.signal);
    return stream;
  });
  const session = new WorkerSession({
    project: makeProject(),
    scope: "alpha#1",
    worktreePath: "/tmp/wt/1",
    journal,
    onActivity: () => {},
    canUseTool: vi.fn(),
  });
  return { session, push: (message: SDKMessage) => stream!.push(message) };
}

const completedResult = {
  type: "result",
  subtype: "success",
  total_cost_usd: 0.01,
  num_turns: 1,
  structured_output: {
    status: "completed",
    summary: "Did the thing.",
    filesChanged: [],
    confidence: "high",
    prTitle: "feat: the thing",
    prBody: "did it",
  },
} as unknown as SDKMessage;

beforeEach(() => {
  vi.useFakeTimers();
  queryMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkerSession turn clock (fleet#225)", () => {
  it("does not abort a turn while an approval keeps the clock paused, even well past the configured timeout", async () => {
    const { session, push } = makeSession();
    const turnPromise = session.nextResult(60_000); // ticketTimeoutMinutes: 1

    session.pauseTurnClock();
    await vi.advanceTimersByTimeAsync(3 * 60_000); // approval left pending for 3 minutes
    expect(session.abortController.signal.aborted).toBe(false);

    session.resumeTurnClock();
    push(completedResult);

    const turn = await turnPromise;
    expect(turn.errorSubtype).toBeUndefined();
    expect(turn.kind).toBe("code");
    expect(turn.result?.status).toBe("completed");
  });

  it("resumes with the remaining budget rather than a fresh timeout once the approval settles", async () => {
    const { session } = makeSession();
    const turnPromise = session.nextResult(60_000);

    await vi.advanceTimersByTimeAsync(50_000); // 50s of the 60s budget already spent
    session.pauseTurnClock();
    await vi.advanceTimersByTimeAsync(5 * 60_000); // a long approval wait
    session.resumeTurnClock();

    await vi.advanceTimersByTimeAsync(9_999); // just under the remaining ~10s
    expect(session.abortController.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const turn = await turnPromise;
    expect(turn.errorSubtype).toBe("timed out after 1 minutes");
  });

  it("does not resume until two overlapping approval waits have both settled", async () => {
    const { session, push } = makeSession();
    const turnPromise = session.nextResult(60_000);

    session.pauseTurnClock();
    session.pauseTurnClock();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    session.resumeTurnClock();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(session.abortController.signal.aborted).toBe(false); // one pause still outstanding

    session.resumeTurnClock();
    push(completedResult);

    const turn = await turnPromise;
    expect(turn.errorSubtype).toBeUndefined();
  });

  it("aborts a session mid-wait cleanly: the pending turn settles as a timeout with no leaked timer", async () => {
    const { session } = makeSession();
    const turnPromise = session.nextResult(60_000);

    session.pauseTurnClock();
    session.abortController.abort();

    const turn = await turnPromise;
    expect(turn.errorSubtype).toBe("timed out after 1 minutes");
  });
});
