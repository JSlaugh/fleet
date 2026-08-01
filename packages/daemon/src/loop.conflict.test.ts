import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "./approvals.ts";
import type { LoopContext } from "./context.ts";
import { FleetLoop } from "./loop.ts";
import { addressReviews } from "./reviews.ts";
import { StateStore } from "./state.ts";

vi.mock("./github.ts", async (importActual) => ({
  ...(await importActual<typeof import("./github.ts")>()),
  getPrFeedback: vi.fn(),
  getPrMergeable: vi.fn(),
  swapLabel: vi.fn(async () => {}),
}));

vi.mock("./runner.ts", () => ({
  resumeTicket: vi.fn(async () => {}),
}));

const github = await import("./github.ts");
const runner = await import("./runner.ts");

const project: ProjectConfig = {
  name: "alpha",
  repoPath: "/repo/alpha",
  githubRepo: "acme/alpha",
  defaultBranch: "main",
  maxConcurrent: 2,
  planChildrenReady: false,
  autoElevateOnFailure: true,
  autoAddressReviews: true,
  machineReview: false,
};

const noFeedback = { reviews: [], comments: [], hasChangesRequested: false, latestAt: undefined };
const feedback = {
  reviews: [{ author: "alice", state: "CHANGES_REQUESTED", body: "fix this", submittedAt: "2026-01-02T00:00:00.000Z" }],
  comments: [],
  hasChangesRequested: true,
  latestAt: "2026-01-02T00:00:00.000Z",
};

function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    sessionId: "sess-7",
    status: "review",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 3,
    prUrl: "https://github.com/acme/alpha/pull/7",
    ...patch,
  };
}

function makeCtx(seed?: TicketRecord): { ctx: LoopContext; state: StateStore } {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-conflict-"));
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
  const ctx = (loop as unknown as { ctx: LoopContext }).ctx;
  return { ctx, state };
}

const openIssues = new Set([7]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(github.getPrFeedback).mockResolvedValue(noFeedback);
});

describe("addressReviews — conflict detection", () => {
  it("resumes with a conflict prompt on a fresh CONFLICTING PR and sets the guard", async () => {
    vi.mocked(github.getPrMergeable).mockResolvedValue("CONFLICTING");
    const { ctx, state } = makeCtx(record());

    await addressReviews(ctx, project, openIssues);

    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:review", "fleet:in-progress");
    expect(runner.resumeTicket).toHaveBeenCalledOnce();
    const prompt = vi.mocked(runner.resumeTicket).mock.calls[0]?.[3] as string;
    expect(prompt).toContain("Merge conflict");
    expect(prompt).toContain("origin/main");
    expect(state.get("alpha", 7)?.conflictHandled).toBe(true);
  });

  it("never resumes on UNKNOWN mergeability", async () => {
    vi.mocked(github.getPrMergeable).mockResolvedValue("UNKNOWN");
    const { ctx, state } = makeCtx(record());

    await addressReviews(ctx, project, openIssues);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.conflictHandled).toBeUndefined();
  });

  it("does not resume again for a CONFLICTING PR already handled", async () => {
    vi.mocked(github.getPrMergeable).mockResolvedValue("CONFLICTING");
    const { ctx } = makeCtx(record({ conflictHandled: true }));

    await addressReviews(ctx, project, openIssues);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
  });

  it("clears the guard once the PR reports MERGEABLE again, making a later conflict eligible", async () => {
    vi.mocked(github.getPrMergeable).mockResolvedValue("MERGEABLE");
    const { ctx, state } = makeCtx(record({ conflictHandled: true }));

    await addressReviews(ctx, project, openIssues);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.conflictHandled).toBe(false);
  });

  it("combines fresh review feedback and a conflict into a single resume", async () => {
    vi.mocked(github.getPrMergeable).mockResolvedValue("CONFLICTING");
    vi.mocked(github.getPrFeedback).mockResolvedValue(feedback);
    const { ctx, state } = makeCtx(record());

    await addressReviews(ctx, project, openIssues);

    expect(runner.resumeTicket).toHaveBeenCalledOnce();
    const prompt = vi.mocked(runner.resumeTicket).mock.calls[0]?.[3] as string;
    expect(prompt).toContain("fix this");
    expect(prompt).toContain("Merge conflict");
    expect(state.get("alpha", 7)?.lastReviewHandledAt).toBe("2026-01-02T00:00:00.000Z");
    expect(state.get("alpha", 7)?.conflictHandled).toBe(true);
  });

  it("still handles feedback alone when the PR is MERGEABLE", async () => {
    vi.mocked(github.getPrMergeable).mockResolvedValue("MERGEABLE");
    vi.mocked(github.getPrFeedback).mockResolvedValue(feedback);
    const { ctx } = makeCtx(record());

    await addressReviews(ctx, project, openIssues);

    expect(runner.resumeTicket).toHaveBeenCalledOnce();
    const prompt = vi.mocked(runner.resumeTicket).mock.calls[0]?.[3] as string;
    expect(prompt).toContain("fix this");
    expect(prompt).not.toContain("Merge conflict");
  });

  it("does nothing when there is neither feedback nor a conflict", async () => {
    vi.mocked(github.getPrMergeable).mockResolvedValue("MERGEABLE");
    const { ctx } = makeCtx(record());

    await addressReviews(ctx, project, openIssues);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("falls back to UNKNOWN and does not resume when fetching mergeable state throws", async () => {
    vi.mocked(github.getPrMergeable).mockRejectedValue(new Error("gh: rate limited"));
    const { ctx } = makeCtx(record());

    await addressReviews(ctx, project, openIssues);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
  });
});
