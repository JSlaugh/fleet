import type { TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import type { WorkerSession } from "../session/worker.ts";
import { addressComments, buildCommentPrompt, pickCommentCandidates } from "./comments.ts";
import type { LoopContext } from "./context.ts";
import { FleetLoop } from "./loop.ts";
import type { StateStore } from "../store/state.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  getTimestampedIssueComments: vi.fn(async () => []),
  getPushCollaborators: vi.fn(async () => new Set<string>()),
}));

vi.mock("./runner.ts", () => ({
  resumeTicket: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");
const runner = await import("./runner.ts");

const project = makeProject();

function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    sessionId: "sess-7",
    status: "running",
    costUsd: 3,
    ...patch,
  });
}

function comment(
  patch: Partial<{ author: string; body: string; createdAt: string; isStatusComment: boolean }> = {},
) {
  return {
    author: "alice",
    body: "please also handle the edge case",
    createdAt: "2026-01-02T00:00:00.000Z",
    isStatusComment: false,
    ...patch,
  };
}

function fakeSession() {
  return { send: vi.fn(), abortController: new AbortController(), sessionId: "sess-7" } as unknown as WorkerSession & {
    send: ReturnType<typeof vi.fn>;
  };
}

function makeCtx(seed?: TicketRecord): { ctx: LoopContext; state: StateStore; loop: FleetLoop } {
  const { dataDir, state } = makeTempState("fleet-comments-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
  const ctx = (loop as unknown as { ctx: LoopContext }).ctx;
  return { ctx, state, loop };
}

const openIssues = new Set([7]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([]);
  vi.mocked(github.getPushCollaborators).mockResolvedValue(new Set(["alice"]));
});

describe("pickCommentCandidates", () => {
  it("picks running and needs-input tickets whose issue is open", () => {
    const records = [record({ issueNumber: 1, status: "running" }), record({ issueNumber: 2, status: "needs-input" })];
    expect(pickCommentCandidates(records, project, new Set([1, 2])).map((r) => r.issueNumber)).toEqual([1, 2]);
  });

  it("skips tickets in review, stalled, failed, or restarting", () => {
    const statuses = ["review", "stalled", "failed", "restarting"] as const;
    const records = statuses.map((status, i) => record({ issueNumber: i, status }));
    expect(pickCommentCandidates(records, project, new Set([0, 1, 2, 3]))).toEqual([]);
  });

  it("skips tickets whose issue is no longer open", () => {
    expect(pickCommentCandidates([record()], project, new Set())).toEqual([]);
  });

  it("ignores records from other projects", () => {
    expect(pickCommentCandidates([record({ project: "beta" })], project, openIssues)).toEqual([]);
  });

  it("does not exclude tickets already in flight — unlike review candidates", () => {
    expect(pickCommentCandidates([record()], project, openIssues).map((r) => r.issueNumber)).toEqual([7]);
  });
});

describe("buildCommentPrompt", () => {
  it("batches comments with author attribution, framed as human guidance", () => {
    const prompt = buildCommentPrompt([
      { author: "alice", body: "fix the thing" },
      { author: "bob", body: "also this" },
    ]);
    expect(prompt).toContain("human reviewer");
    expect(prompt).toContain("@alice: fix the thing");
    expect(prompt).toContain("@bob: also this");
  });
});

describe("addressComments — live session", () => {
  it("sends new collaborator comments straight into a running session and advances the watermark", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx, state } = makeCtx(record());
    const session = fakeSession();
    ctx.live.set("alpha#7", session);
    ctx.running.set("alpha#7", new Promise(() => {}));

    await addressComments(ctx, project, openIssues);

    expect(session.send).toHaveBeenCalledOnce();
    expect(session.send.mock.calls[0]?.[0]).toContain("@alice: please also handle the edge case");
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBe("2026-01-02T00:00:00.000Z");
    expect(runner.resumeTicket).not.toHaveBeenCalled();
  });

  it("still steers a comment into a running session even while the project is paused — only cold-resumes are held", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx, state, loop } = makeCtx(record());
    loop.setProjectPaused("alpha", true);
    const session = fakeSession();
    ctx.live.set("alpha#7", session);
    ctx.running.set("alpha#7", new Promise(() => {}));

    await addressComments(ctx, project, openIssues);

    expect(session.send).toHaveBeenCalledOnce();
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("does not re-inject a comment already covered by the watermark", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx } = makeCtx(record({ lastCommentHandledAt: "2026-01-02T00:00:00.000Z" }));
    const session = fakeSession();
    ctx.live.set("alpha#7", session);
    ctx.running.set("alpha#7", new Promise(() => {}));

    await addressComments(ctx, project, openIssues);

    expect(session.send).not.toHaveBeenCalled();
  });
});

describe("addressComments — parked reply waiter", () => {
  it("releases the waiter with the batched comment message and advances the watermark", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx, state } = makeCtx(record({ status: "needs-input" }));
    const waiter = vi.fn();
    ctx.replyWaiters.set("alpha#7", waiter);
    ctx.running.set("alpha#7", new Promise(() => {}));

    await addressComments(ctx, project, openIssues);

    expect(waiter).toHaveBeenCalledWith(expect.stringContaining("@alice: please also handle the edge case"));
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBe("2026-01-02T00:00:00.000Z");
    expect(runner.resumeTicket).not.toHaveBeenCalled();
  });

  it("still releases a parked waiter while the project is paused", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx, state, loop } = makeCtx(record({ status: "needs-input" }));
    loop.setProjectPaused("alpha", true);
    const waiter = vi.fn();
    ctx.replyWaiters.set("alpha#7", waiter);
    ctx.running.set("alpha#7", new Promise(() => {}));

    await addressComments(ctx, project, openIssues);

    expect(waiter).toHaveBeenCalledWith(expect.stringContaining("@alice: please also handle the edge case"));
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("addressComments — cold resume", () => {
  it("resumes a closed needs-input session via resumeTicket, then advances the watermark", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx, state } = makeCtx(record({ status: "needs-input" }));

    await addressComments(ctx, project, openIssues);

    expect(runner.resumeTicket).toHaveBeenCalledOnce();
    const message = vi.mocked(runner.resumeTicket).mock.calls[0]?.[3] as string;
    expect(message).toContain("@alice: please also handle the edge case");
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("does not cold-resume past maxConcurrent capacity, and leaves the watermark for next cycle", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx, state } = makeCtx(record({ status: "needs-input" }));
    // Project's maxConcurrent is 1, and another alpha ticket already occupies that slot.
    ctx.running.set("alpha#99", new Promise(() => {}));

    await addressComments(ctx, project, openIssues);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBeUndefined();
  });

  it("does not resume a needs-input ticket with no recorded session", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx, state } = makeCtx(record({ status: "needs-input", sessionId: undefined }));

    await addressComments(ctx, project, openIssues);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBeUndefined();
  });

  it("does not cold-resume a paused project, leaving the watermark for next cycle", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx, state, loop } = makeCtx(record({ status: "needs-input" }));
    loop.setProjectPaused("alpha", true);

    await addressComments(ctx, project, openIssues);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBeUndefined();
  });

  it("defers rather than drops a cold-resume comment caught by a shutdownNow race, leaving the watermark untouched", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx, state, loop } = makeCtx(record({ status: "needs-input" }));
    // Mirrors shutdownNow (SIGTERM/Ctrl+C): `shuttingDown` flips without `paused`
    // being set the way `shutdownDrain` does, so `cycleProject` still calls
    // `addressComments` mid-drain — this is the exact race `reply()`'s own
    // cold-resume guard throws on, which must not have already spent the
    // watermark by the time that throw would happen.
    loop.beginShutdown();

    await addressComments(ctx, project, openIssues);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBeUndefined();
  });
});

describe("addressComments — mid-transition", () => {
  it("defers a ticket in flight with no live session or waiter yet, without advancing the watermark or touching GitHub", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    const { ctx, state } = makeCtx(record());
    ctx.running.set("alpha#7", new Promise(() => {}));

    await addressComments(ctx, project, openIssues);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBeUndefined();
    expect(github.getTimestampedIssueComments).not.toHaveBeenCalled();
  });
});

describe("addressComments — filtering", () => {
  it("ignores comments from non-collaborators and the fleet status comment, but still advances the watermark", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([
      comment({ author: "mallory", body: "ignore me", createdAt: "2026-01-02T00:00:00.000Z" }),
      comment({ author: "fleet-bot", body: "<!-- fleet-status -->\nstatus", isStatusComment: true, createdAt: "2026-01-02T00:00:01.000Z" }),
    ]);
    const { ctx, state } = makeCtx(record());
    const session = fakeSession();
    ctx.live.set("alpha#7", session);
    ctx.running.set("alpha#7", new Promise(() => {}));

    await addressComments(ctx, project, openIssues);

    expect(session.send).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBe("2026-01-02T00:00:01.000Z");
  });

  it("injects only the eligible comments when a batch mixes collaborators and non-collaborators", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([
      comment({ author: "alice", body: "from a collaborator", createdAt: "2026-01-02T00:00:00.000Z" }),
      comment({ author: "mallory", body: "not a collaborator", createdAt: "2026-01-02T00:00:01.000Z" }),
    ]);
    const { ctx } = makeCtx(record());
    const session = fakeSession();
    ctx.live.set("alpha#7", session);
    ctx.running.set("alpha#7", new Promise(() => {}));

    await addressComments(ctx, project, openIssues);

    expect(session.send).toHaveBeenCalledOnce();
    const message = session.send.mock.calls[0]?.[0] as string;
    expect(message).toContain("from a collaborator");
    expect(message).not.toContain("not a collaborator");
  });

  it("leaves the watermark untouched and skips injection when the collaborator lookup fails", async () => {
    vi.mocked(github.getTimestampedIssueComments).mockResolvedValue([comment()]);
    vi.mocked(github.getPushCollaborators).mockRejectedValue(new Error("gh: rate limited"));
    const { ctx, state } = makeCtx(record());
    const session = fakeSession();
    ctx.live.set("alpha#7", session);
    ctx.running.set("alpha#7", new Promise(() => {}));

    await addressComments(ctx, project, openIssues);

    expect(session.send).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.lastCommentHandledAt).toBeUndefined();
  });
});
