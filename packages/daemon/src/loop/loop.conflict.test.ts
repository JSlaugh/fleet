import type { TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import type { LoopContext } from "./context.ts";
import { FleetLoop } from "./loop.ts";
import { addressReviews } from "./reviews.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  getPrFeedback: vi.fn(),
  getPrMergeable: vi.fn(),
  swapLabel: vi.fn(async () => {}),
}));

vi.mock("./runner.ts", () => ({
  resumeTicket: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");
const runner = await import("./runner.ts");

const project = makeProject({ maxConcurrent: 2 });

const noFeedback = { reviews: [], comments: [], hasChangesRequested: false, latestAt: undefined };
const feedback = {
  reviews: [{ author: "alice", state: "CHANGES_REQUESTED", body: "fix this", submittedAt: "2026-01-02T00:00:00.000Z" }],
  comments: [],
  hasChangesRequested: true,
  latestAt: "2026-01-02T00:00:00.000Z",
};

function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    sessionId: "sess-7",
    status: "review",
    costUsd: 3,
    prUrl: "https://github.com/acme/alpha/pull/7",
    ...patch,
  });
}

function makeCtx(seed?: TicketRecord) {
  const { dataDir, state } = makeTempState("fleet-conflict-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
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
    const call = vi.mocked(runner.resumeTicket).mock.calls[0];
    expect(call?.[3] as string).toContain("Merge conflict");
    expect(call?.[3] as string).toContain("origin/main");
    expect(call?.[4]).toBe("conflict");
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
    const call = vi.mocked(runner.resumeTicket).mock.calls[0];
    expect(call?.[3] as string).toContain("fix this");
    expect(call?.[3] as string).toContain("Merge conflict");
    expect(call?.[4]).toBe("review-feedback+conflict");
    expect(state.get("alpha", 7)?.lastReviewHandledAt).toBe("2026-01-02T00:00:00.000Z");
    expect(state.get("alpha", 7)?.conflictHandled).toBe(true);
  });

  it("still handles feedback alone when the PR is MERGEABLE", async () => {
    vi.mocked(github.getPrMergeable).mockResolvedValue("MERGEABLE");
    vi.mocked(github.getPrFeedback).mockResolvedValue(feedback);
    const { ctx } = makeCtx(record());

    await addressReviews(ctx, project, openIssues);

    expect(runner.resumeTicket).toHaveBeenCalledOnce();
    const call = vi.mocked(runner.resumeTicket).mock.calls[0];
    expect(call?.[3] as string).toContain("fix this");
    expect(call?.[3] as string).not.toContain("Merge conflict");
    expect(call?.[4]).toBe("review-feedback");
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
