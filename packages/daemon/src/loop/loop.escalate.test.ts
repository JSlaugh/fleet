import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import type { LoopContext } from "./context.ts";
import { PostCompletionError, reportRunFailure, shouldAutoElevate } from "./finish.ts";
import { FleetLoop } from "./loop.ts";

vi.mock("../github/github.ts", () => ({
  createPullRequest: vi.fn(),
  escalateToElevated: vi.fn(async () => {}),
  getIssueComments: vi.fn(async () => []),
  getIssueLabels: vi.fn(async () => []),
  getPrState: vi.fn(),
  listFleetIssues: vi.fn(async () => []),
  markReady: vi.fn(async () => {}),
  swapLabel: vi.fn(async () => {}),
  toBoardTicket: vi.fn(),
  upsertStatusComment: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

describe("shouldAutoElevate", () => {
  it("escalates a first failure when an elevated model is configured", () => {
    expect(shouldAutoElevate({ elevatedModel: "claude-opus-5" }, {})).toBe(true);
  });

  it("does not escalate a failure with no record — a claim-phase infrastructure failure a stronger model can't fix", () => {
    expect(shouldAutoElevate({ elevatedModel: "claude-opus-5" }, undefined)).toBe(false);
  });

  it("does not escalate without an elevated model configured", () => {
    expect(shouldAutoElevate({}, {})).toBe(false);
  });

  it("does not escalate when the project opts out", () => {
    expect(shouldAutoElevate({ elevatedModel: "claude-opus-5", autoElevateOnFailure: false }, {})).toBe(false);
  });

  it("does not escalate a run that was already elevated (manual fleet:elevate)", () => {
    expect(shouldAutoElevate({ elevatedModel: "claude-opus-5" }, { elevated: true })).toBe(false);
  });

  it("does not escalate a ticket that has already auto-elevated once", () => {
    expect(shouldAutoElevate({ elevatedModel: "claude-opus-5" }, { autoElevated: true })).toBe(false);
  });

  it("escalates when the record has neither flag set", () => {
    expect(shouldAutoElevate({ elevatedModel: "claude-opus-5" }, { elevated: false, autoElevated: false })).toBe(true);
  });

  it("does not escalate a run that recorded exactly zero cost — the session never reached the model", () => {
    expect(shouldAutoElevate({ elevatedModel: "claude-opus-5" }, { costUsd: 0 })).toBe(false);
  });

  it("still escalates a failure with non-zero cost — a genuine cheap-but-real failure", () => {
    expect(shouldAutoElevate({ elevatedModel: "claude-opus-5" }, { costUsd: 0.01 })).toBe(true);
  });
});

const project = makeProject({ elevatedModel: "claude-opus-5" });

function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    sessionId: "sess-7",
    costUsd: 3,
    ...patch,
  });
}

function makeLoop(seed?: TicketRecord) {
  const { dataDir, state } = makeTempState("fleet-escalate-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
  const internals = loop as unknown as {
    finishFailed: (
      p: ProjectConfig,
      issue: { number: number; title: string },
      error: string,
      opts?: { postCompletion?: boolean; turnCount?: number },
    ) => Promise<void>;
    ctx: LoopContext;
  };
  return { loop, state, internals };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("finishFailed auto-escalation", () => {
  it("escalates a first failure instead of parking in needs-input", async () => {
    const { state, internals } = makeLoop(record({ elevated: false, autoElevated: false }));

    await internals.finishFailed(project, { number: 7, title: "issue 7" }, "boom");

    expect(github.escalateToElevated).toHaveBeenCalledWith(project, 7);
    expect(github.swapLabel).not.toHaveBeenCalled();
    const updated = state.get("alpha", 7);
    expect(updated?.autoElevated).toBe(true);
    const commentBody = vi.mocked(github.upsertStatusComment).mock.calls[0]?.[2] ?? "";
    expect(commentBody).toContain("Retrying automatically");
  });

  it("falls back to needs-input once the ticket has already auto-elevated once", async () => {
    const { state, internals } = makeLoop(record({ elevated: true, autoElevated: true }));

    await internals.finishFailed(project, { number: 7, title: "issue 7" }, "boom again");

    expect(github.escalateToElevated).not.toHaveBeenCalled();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    expect(state.get("alpha", 7)?.status).toBe("failed");
  });

  it("behaves exactly as today for a manually-elevated failure", async () => {
    const { internals } = makeLoop(record({ elevated: true, autoElevated: false }));

    await internals.finishFailed(project, { number: 7, title: "issue 7" }, "boom");

    expect(github.escalateToElevated).not.toHaveBeenCalled();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
  });

  it("behaves exactly as today when the project opts out of auto-escalation", async () => {
    const optedOut = makeProject({ elevatedModel: "claude-opus-5", autoElevateOnFailure: false });
    const { internals } = makeLoop(record({ elevated: false, autoElevated: false }));

    await internals.finishFailed(optedOut, { number: 7, title: "issue 7" }, "boom");

    expect(github.escalateToElevated).not.toHaveBeenCalled();
    expect(github.swapLabel).toHaveBeenCalledWith(optedOut, 7, "fleet:in-progress", "fleet:needs-input");
  });

  it("never auto-elevates a post-completion failure, even when the ticket is otherwise eligible", async () => {
    const { state, internals } = makeLoop(record({ elevated: false, autoElevated: false }));

    await internals.finishFailed(
      project,
      { number: 7, title: "issue 7" },
      "git push ... failed (exit 1): ! [rejected] (non-fast-forward)",
      { postCompletion: true },
    );

    expect(github.escalateToElevated).not.toHaveBeenCalled();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    const updated = state.get("alpha", 7);
    expect(updated?.autoElevated).toBeFalsy();
    const commentBody = vi.mocked(github.upsertStatusComment).mock.calls[0]?.[2] ?? "";
    expect(commentBody).toContain("completed successfully");
    expect(commentBody).toContain("non-fast-forward");
  });

  it("still auto-elevates a session-phase failure (postCompletion unset) exactly as today", async () => {
    const { state, internals } = makeLoop(record({ elevated: false, autoElevated: false }));

    await internals.finishFailed(project, { number: 7, title: "issue 7" }, "SDK query rejected");

    expect(github.escalateToElevated).toHaveBeenCalledWith(project, 7);
    expect(state.get("alpha", 7)?.autoElevated).toBe(true);
  });

  it("does not auto-elevate a single-turn, $0.00 run — it parks in needs-input naming the turn count and cost", async () => {
    const { state, internals } = makeLoop(record({ elevated: false, autoElevated: false, costUsd: 0 }));

    await internals.finishFailed(project, { number: 7, title: "issue 7" }, "expired credentials", { turnCount: 1 });

    expect(github.escalateToElevated).not.toHaveBeenCalled();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    const updated = state.get("alpha", 7);
    expect(updated?.autoElevated).toBeFalsy();
    const commentBody = vi.mocked(github.upsertStatusComment).mock.calls[0]?.[2] ?? "";
    expect(commentBody).toContain("1 turn");
    expect(commentBody).toContain("$0.00");
  });

  it("does not consume the once-only auto-elevation on a zero-cost run, so a later real failure can still elevate", async () => {
    const { state, internals } = makeLoop(record({ elevated: false, autoElevated: false, costUsd: 0 }));

    await internals.finishFailed(project, { number: 7, title: "issue 7" }, "expired credentials", { turnCount: 1 });
    expect(state.get("alpha", 7)?.autoElevated).toBeFalsy();

    // The underlying infrastructure issue is fixed and the ticket runs again, this time doing real work before failing.
    state.update("alpha", 7, { costUsd: 4 });
    vi.clearAllMocks();
    await internals.finishFailed(project, { number: 7, title: "issue 7" }, "boom", { turnCount: 3 });

    expect(github.escalateToElevated).toHaveBeenCalledWith(project, 7);
    expect(state.get("alpha", 7)?.autoElevated).toBe(true);
  });

  it("still auto-elevates a failed run that did real work (non-zero cost), exactly as today", async () => {
    const { state, internals } = makeLoop(record({ elevated: false, autoElevated: false, costUsd: 0.42 }));

    await internals.finishFailed(project, { number: 7, title: "issue 7" }, "boom", { turnCount: 3 });

    expect(github.escalateToElevated).toHaveBeenCalledWith(project, 7);
    expect(state.get("alpha", 7)?.autoElevated).toBe(true);
  });
});

describe("reportRunFailure — routing a PostCompletionError", () => {
  it("marks the failure as post-completion so finishFailed never auto-elevates it", async () => {
    const { state, internals } = makeLoop(record({ elevated: false, autoElevated: false }));

    await reportRunFailure(
      internals.ctx,
      project,
      { number: 7, title: "issue 7", body: "", labels: [], author: "collab-author" },
      "failed",
      new PostCompletionError("the worker completed successfully (commits exist on `fleet/7`) but the push/PR pipeline failed: non-fast-forward"),
    );

    expect(github.escalateToElevated).not.toHaveBeenCalled();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    expect(state.get("alpha", 7)?.autoElevated).toBeFalsy();
  });

  it("still auto-elevates a plain error (e.g. a crashed SDK session)", async () => {
    const { state, internals } = makeLoop(record({ elevated: false, autoElevated: false }));

    await reportRunFailure(internals.ctx, project, { number: 7, title: "issue 7", body: "", labels: [], author: "collab-author" }, "failed", new Error("SDK crashed"));

    expect(github.escalateToElevated).toHaveBeenCalledWith(project, 7);
    expect(state.get("alpha", 7)?.autoElevated).toBe(true);
  });
});
