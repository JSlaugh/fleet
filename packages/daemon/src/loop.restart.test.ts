import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "./approvals.ts";
import { FleetLoop } from "./loop.ts";
import { StateStore } from "./state.ts";

vi.mock("./github.ts", () => ({
  createPullRequest: vi.fn(),
  getIssueComments: vi.fn(async () => []),
  getIssueLabels: vi.fn(async () => []),
  getPrState: vi.fn(),
  listFleetIssues: vi.fn(async () => []),
  markReady: vi.fn(async () => {}),
  swapLabel: vi.fn(async () => {}),
  toBoardTicket: vi.fn(),
  upsertStatusComment: vi.fn(async () => {}),
}));

const github = await import("./github.ts");

const project: ProjectConfig = {
  name: "alpha",
  repoPath: "/repo/alpha",
  githubRepo: "acme/alpha",
  defaultBranch: "main",
  maxConcurrent: 1,
  planChildrenReady: false,
  autoElevateOnFailure: true,
};

function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    sessionId: "sess-7",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 3,
    sessionLive: true,
    autoResumed: true,
    ...patch,
  };
}

/** A `FleetLoop` over a throwaway data dir, plus handles on its private maps. */
function makeLoop(seed?: TicketRecord) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-restart-"));
  const state = new StateStore(dataDir);
  if (seed) state.upsert(seed);
  const config: FleetConfig = {
    pollIntervalSeconds: 60,
    dashboardPort: 4400,
    worktreeRoot: "/tmp/wt",
    stalledAfterMinutes: 10,
    ticketTimeoutMinutes: 30,
    approvalTimeoutMinutes: 10,
    replyWaitMinutes: 60,
    dataDir,
    projects: [project],
  };
  const approvals = { request: vi.fn() } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const internals = loop as unknown as {
    live: Map<string, { abortController: AbortController; sessionId?: string }>;
    running: Map<string, Promise<void>>;
    replyWaiters: Map<string, (message: string | undefined) => void>;
    finishFailed: (p: ProjectConfig, issue: { number: number; title: string }, error: string) => Promise<void>;
  };
  return { loop, state, dataDir, internals };
}

function journalEvents(dataDir: string, issueNumber: number): string[] {
  const file = join(dataDir, "journals", project.name, `${issueNumber}.jsonl`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => String((JSON.parse(line) as { event?: unknown }).event ?? ""));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("restartTicket with no live session", () => {
  it("re-queues the issue and clears what would make the next cycle resume", async () => {
    const { loop, state, dataDir } = makeLoop(record({ status: "failed", sessionLive: false }));

    await loop.restartTicket("alpha", 7);

    expect(github.markReady).toHaveBeenCalledWith(project, 7);
    const updated = state.get("alpha", 7);
    expect(updated?.sessionId).toBeUndefined();
    expect(updated?.sessionLive).toBe(false);
    expect(updated?.autoResumed).toBe(false);
    expect(updated?.status).toBe("restarting");
    expect(journalEvents(dataDir, 7)).toEqual(["restarted-by-operator"]);
  });

  it("posts a restart status comment rather than a failure one", async () => {
    const { loop } = makeLoop(record({ status: "needs-input", sessionLive: false }));

    await loop.restartTicket("alpha", 7);

    const body = vi.mocked(github.upsertStatusComment).mock.calls[0]?.[2] ?? "";
    expect(body).toContain("restarting");
    expect(body).not.toContain("failed");
  });

  it("still re-queues an issue that has no state record at all", async () => {
    const { loop } = makeLoop();

    await loop.restartTicket("alpha", 7);

    expect(github.markReady).toHaveBeenCalledWith(project, 7);
  });

  it("rejects an unknown project", async () => {
    const { loop } = makeLoop(record());
    await expect(loop.restartTicket("beta", 7)).rejects.toThrow(/unknown project/);
    expect(github.markReady).not.toHaveBeenCalled();
  });
});

describe("restartTicket with a live session", () => {
  it("aborts the session and waits for the run to unwind before resetting", async () => {
    const { loop, state, internals } = makeLoop(record());
    const abortController = new AbortController();
    internals.live.set("alpha#7", { abortController, sessionId: "sess-7" });
    let unwound = false;
    internals.running.set(
      "alpha#7",
      new Promise<void>((resolve) => {
        abortController.signal.addEventListener("abort", () => {
          // Stand in for `runSession`'s teardown, which writes the session id back.
          state.update("alpha", 7, { sessionLive: false, sessionId: "sess-7" });
          unwound = true;
          resolve();
        });
      }),
    );

    await loop.restartTicket("alpha", 7);

    expect(abortController.signal.aborted).toBe(true);
    expect(unwound).toBe(true);
    // The reset must land after the teardown, not before it.
    expect(state.get("alpha", 7)?.sessionId).toBeUndefined();
  });

  it("releases a session parked awaiting a reply so it does not wait out replyWaitMinutes", async () => {
    const { loop, internals } = makeLoop(record({ status: "needs-input" }));
    const abortController = new AbortController();
    internals.live.set("alpha#7", { abortController });
    const parked = new Promise<string | undefined>((resolve) => {
      internals.replyWaiters.set("alpha#7", resolve);
    });
    internals.running.set("alpha#7", parked.then(() => undefined));

    await loop.restartTicket("alpha", 7);

    await expect(parked).resolves.toBeUndefined();
  });

  it("skips GitHub failure reporting for the aborted turn", async () => {
    const { loop, state, internals } = makeLoop(record());
    const abortController = new AbortController();
    internals.live.set("alpha#7", { abortController });
    internals.running.set(
      "alpha#7",
      new Promise<void>((resolve) => {
        abortController.signal.addEventListener("abort", () => {
          // What `supervise` does with the errored turn an abort produces.
          void internals
            .finishFailed(project, { number: 7, title: "issue 7" }, "timed out after 30 minutes")
            .then(resolve);
        });
      }),
    );

    await loop.restartTicket("alpha", 7);

    expect(github.swapLabel).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.status).toBe("restarting");
    for (const call of vi.mocked(github.upsertStatusComment).mock.calls) {
      expect(call[2]).not.toContain("Status: failed");
    }
  });

  it("reports a failure normally once the restart has finished", async () => {
    const { loop, internals } = makeLoop(record({ status: "failed", sessionLive: false }));

    await loop.restartTicket("alpha", 7);
    await internals.finishFailed(project, { number: 7, title: "issue 7" }, "boom");

    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
  });

  it("resets anyway when a wedged session ignores the abort, and keeps suppressing its failure", async () => {
    vi.useFakeTimers();
    try {
      const { loop, internals } = makeLoop(record());
      const abortController = new AbortController();
      internals.live.set("alpha#7", { abortController });
      let settle: (() => void) | undefined;
      internals.running.set("alpha#7", new Promise<void>((resolve) => (settle = resolve)));

      const restarted = loop.restartTicket("alpha", 7);
      await vi.advanceTimersByTimeAsync(30_000);
      await restarted;

      expect(github.markReady).toHaveBeenCalledWith(project, 7);
      // The run is still out there: its eventual failure must not undo the reset.
      await internals.finishFailed(project, { number: 7, title: "issue 7" }, "wedged");
      expect(github.swapLabel).not.toHaveBeenCalled();

      settle?.();
      await vi.advanceTimersByTimeAsync(0);
      await internals.finishFailed(project, { number: 7, title: "issue 7" }, "later failure");
      expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a ticket that is in flight with no session to abort", async () => {
    const { loop, internals } = makeLoop(record());
    internals.running.set("alpha#7", new Promise<void>(() => {}));

    await expect(loop.restartTicket("alpha", 7)).rejects.toThrow(/mid-transition/);
    expect(github.markReady).not.toHaveBeenCalled();
  });
});
