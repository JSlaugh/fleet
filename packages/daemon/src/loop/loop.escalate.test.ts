import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import type { LoopContext } from "./context.ts";
import { PostCompletionError, reportRunFailure, shouldAutoElevate } from "./finish.ts";
import { FleetLoop } from "./loop.ts";
import { StateStore } from "../store/state.ts";

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
    expect(shouldAutoElevate({ elevatedModel: "claude-opus-5" }, undefined)).toBe(true);
  });

  it("does not escalate without an elevated model configured", () => {
    expect(shouldAutoElevate({}, undefined)).toBe(false);
  });

  it("does not escalate when the project opts out", () => {
    expect(shouldAutoElevate({ elevatedModel: "claude-opus-5", autoElevateOnFailure: false }, undefined)).toBe(false);
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
});

const project: ProjectConfig = {
  name: "alpha",
  repoPath: "/repo/alpha",
  githubRepo: "acme/alpha",
  defaultBranch: "main",
  maxConcurrent: 1,
  maxInReview: 3,
  planChildrenReady: false,
  autoElevateOnFailure: true,
  autoAddressReviews: true,
  machineReview: false,
  elevatedModel: "claude-opus-5",
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
    ...patch,
  };
}

function makeLoop(seed?: TicketRecord) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-escalate-"));
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
    limitResumeSlackMinutes: 5,
    limitDefaultBackoffMinutes: 300,
    dataDir,
    projects: [project],
  };
  const approvals = { request: vi.fn() } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const internals = loop as unknown as {
    finishFailed: (
      p: ProjectConfig,
      issue: { number: number; title: string },
      error: string,
      opts?: { postCompletion?: boolean },
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
    const optedOut: ProjectConfig = { ...project, autoElevateOnFailure: false };
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
});

describe("reportRunFailure — routing a PostCompletionError", () => {
  it("marks the failure as post-completion so finishFailed never auto-elevates it", async () => {
    const { state, internals } = makeLoop(record({ elevated: false, autoElevated: false }));

    await reportRunFailure(
      internals.ctx,
      project,
      { number: 7, title: "issue 7", body: "", labels: [] },
      "failed",
      new PostCompletionError("the worker completed successfully (commits exist on `fleet/7`) but the push/PR pipeline failed: non-fast-forward"),
    );

    expect(github.escalateToElevated).not.toHaveBeenCalled();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    expect(state.get("alpha", 7)?.autoElevated).toBeFalsy();
  });

  it("still auto-elevates a plain error (e.g. a crashed SDK session)", async () => {
    const { state, internals } = makeLoop(record({ elevated: false, autoElevated: false }));

    await reportRunFailure(internals.ctx, project, { number: 7, title: "issue 7", body: "", labels: [] }, "failed", new Error("SDK crashed"));

    expect(github.escalateToElevated).toHaveBeenCalledWith(project, 7);
    expect(state.get("alpha", 7)?.autoElevated).toBe(true);
  });
});
