import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCtx, makeFleetConfig, makeIssue, makeProject, makeRecord } from "../test-support.ts";
import { readJournalTail } from "../store/journal.ts";
import { healOrphanedClaims, heartbeatRefreshAgeMs, isClaimStale, releaseStaleClaims, refreshOwnHeartbeats, refreshStalledHeartbeatsOnBoot } from "./heartbeat.ts";
import type { StatusCommentInfo } from "../github/github.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  getStatusCommentInfo: vi.fn(async () => undefined),
  markReady: vi.fn(async () => {}),
  refreshHeartbeat: vi.fn(async () => {}),
  refreshHeartbeatIfStale: vi.fn(async () => {}),
  removeAssignee: vi.fn(async () => {}),
  upsertStatusComment: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

const project = makeProject();
const issue = makeIssue;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isClaimStale", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");

  it("is never stale when there is no status comment at all — too ambiguous to act on", () => {
    expect(isClaimStale(undefined, now, 45)).toBe(false);
  });

  it("uses the heartbeat timestamp when one is present", () => {
    const fresh: StatusCommentInfo = { createdAt: "2020-01-01T00:00:00.000Z", heartbeat: { timestamp: "2026-01-01T11:20:00.000Z", owner: "daemon-a" } };
    expect(isClaimStale(fresh, now, 45)).toBe(false);

    const stale: StatusCommentInfo = { createdAt: "2020-01-01T00:00:00.000Z", heartbeat: { timestamp: "2026-01-01T11:00:00.000Z", owner: "daemon-a" } };
    expect(isClaimStale(stale, now, 45)).toBe(true);
  });

  it("falls back to the comment's own creation time when there's no heartbeat line (a pre-heartbeat claim)", () => {
    const freshComment: StatusCommentInfo = { createdAt: "2026-01-01T11:20:00.000Z" };
    expect(isClaimStale(freshComment, now, 45)).toBe(false);

    const staleComment: StatusCommentInfo = { createdAt: "2026-01-01T11:00:00.000Z" };
    expect(isClaimStale(staleComment, now, 45)).toBe(true);
  });

  it("treats exactly the threshold age as stale (>=, not >)", () => {
    const exact: StatusCommentInfo = { createdAt: "2026-01-01T11:15:00.000Z" };
    expect(isClaimStale(exact, now, 45)).toBe(true);
  });
});

describe("heartbeatRefreshAgeMs", () => {
  it("is half the staleness threshold, in milliseconds", () => {
    expect(heartbeatRefreshAgeMs(45)).toBe(45 * 60_000 / 2);
    expect(heartbeatRefreshAgeMs(10)).toBe(5 * 60_000);
  });
});

describe("healOrphanedClaims", () => {
  it("releases an in-progress issue assigned only to this daemon with no record — the mid-claim-crash orphan", async () => {
    const ctx = makeCtx();

    await healOrphanedClaims(ctx, project, [issue(1, ["fleet:in-progress"], { assignees: ["daemon-a"] })], "daemon-a");

    expect(github.removeAssignee).toHaveBeenCalledWith(project, 1, "daemon-a");
    expect(github.markReady).toHaveBeenCalledWith(project, 1);
  });

  it("releases an unassigned label-stranded issue too (crash before self-assign)", async () => {
    const ctx = makeCtx();

    await healOrphanedClaims(ctx, project, [issue(1, ["fleet:needs-input"], { assignees: [] })], "daemon-a");

    expect(github.markReady).toHaveBeenCalledWith(project, 1);
  });

  it("skips an issue with a TicketRecord — normal recovery owns it", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(makeRecord({ issueNumber: 1, status: "stalled" }));

    await healOrphanedClaims(ctx, project, [issue(1, ["fleet:in-progress"], { assignees: ["daemon-a"] })], "daemon-a");

    expect(github.markReady).not.toHaveBeenCalled();
  });

  it("skips an issue assigned to another daemon — releaseStaleClaims' territory", async () => {
    const ctx = makeCtx();

    await healOrphanedClaims(ctx, project, [issue(1, ["fleet:in-progress"], { assignees: ["daemon-b"] })], "daemon-a");

    expect(github.markReady).not.toHaveBeenCalled();
  });

  it("skips a claim currently in flight in this very cycle", async () => {
    const ctx = makeCtx();
    ctx.running.set("alpha#1", Promise.resolve());

    await healOrphanedClaims(ctx, project, [issue(1, ["fleet:in-progress"], { assignees: ["daemon-a"] })], "daemon-a");

    expect(github.markReady).not.toHaveBeenCalled();
  });

  it("ignores issues without an in-flight status label", async () => {
    const ctx = makeCtx();

    await healOrphanedClaims(ctx, project, [issue(1, ["fleet:review"], { assignees: ["daemon-a"] })], "daemon-a");

    expect(github.markReady).not.toHaveBeenCalled();
  });
});

describe("releaseStaleClaims", () => {
  it("does nothing for an issue with no in-progress/needs-input status label", async () => {
    await releaseStaleClaims(makeCtx(), project, [issue(1, ["fleet:review"], { assignees: ["someone-else"] })], "daemon-a");
    expect(github.getStatusCommentInfo).not.toHaveBeenCalled();
  });

  it("does nothing for an issue with no assignee other than this daemon", async () => {
    await releaseStaleClaims(makeCtx(), project, [issue(1, ["fleet:in-progress"], { assignees: ["daemon-a"] })], "daemon-a");
    expect(github.getStatusCommentInfo).not.toHaveBeenCalled();
  });

  it("does nothing for an unassigned issue carrying a stale status label", async () => {
    await releaseStaleClaims(makeCtx(), project, [issue(1, ["fleet:needs-input"], { assignees: [] })], "daemon-a");
    expect(github.getStatusCommentInfo).not.toHaveBeenCalled();
  });

  it("leaves a peer's claim alone when its heartbeat is fresh", async () => {
    vi.mocked(github.getStatusCommentInfo).mockResolvedValue({
      createdAt: "2020-01-01T00:00:00.000Z",
      heartbeat: { timestamp: new Date().toISOString(), owner: "someone-else" },
    });

    await releaseStaleClaims(makeCtx(), project, [issue(1, ["fleet:in-progress"], { assignees: ["someone-else"] })], "daemon-a");

    expect(github.upsertStatusComment).not.toHaveBeenCalled();
    expect(github.removeAssignee).not.toHaveBeenCalled();
    expect(github.markReady).not.toHaveBeenCalled();
  });

  it("never releases fleet:review even with a stale (or missing) heartbeat", async () => {
    vi.mocked(github.getStatusCommentInfo).mockResolvedValue(undefined);

    await releaseStaleClaims(makeCtx(), project, [issue(1, ["fleet:review"], { assignees: ["someone-else"] })], "daemon-a");

    expect(github.getStatusCommentInfo).not.toHaveBeenCalled();
  });

  it("annotates, unassigns, and re-adds fleet:ready — in that order — for a stale peer claim", async () => {
    vi.mocked(github.getStatusCommentInfo).mockResolvedValue({
      createdAt: "2020-01-01T00:00:00.000Z",
      heartbeat: { timestamp: "2020-01-01T00:00:00.000Z", owner: "someone-else" },
    });
    const calls: string[] = [];
    vi.mocked(github.upsertStatusComment).mockImplementation(async () => void calls.push("comment"));
    vi.mocked(github.removeAssignee).mockImplementation(async () => void calls.push("unassign"));
    vi.mocked(github.markReady).mockImplementation(async () => void calls.push("ready"));

    await releaseStaleClaims(makeCtx(), project, [issue(1, ["fleet:in-progress"], { assignees: ["someone-else"] })], "daemon-a");

    expect(calls).toEqual(["comment", "unassign", "ready"]);
    expect(github.upsertStatusComment).toHaveBeenCalledWith(project, 1, expect.stringContaining("someone-else"));
    expect(github.removeAssignee).toHaveBeenCalledWith(project, 1, "someone-else");
    expect(github.markReady).toHaveBeenCalledWith(project, 1);
  });

  it("journals a stale-claim-released fleet event", async () => {
    vi.mocked(github.getStatusCommentInfo).mockResolvedValue({
      createdAt: "2020-01-01T00:00:00.000Z",
      heartbeat: { timestamp: "2020-01-01T00:00:00.000Z", owner: "someone-else" },
    });
    const ctx = makeCtx();

    await releaseStaleClaims(ctx, project, [issue(1, ["fleet:in-progress"], { assignees: ["someone-else"] })], "daemon-a");

    const entries = readJournalTail(ctx.dataDirPath, project.name, 1, 10);
    expect(entries).toContainEqual(
      expect.objectContaining({ type: "fleet", event: "stale-claim-released", owners: ["someone-else"] }),
    );
  });

  it("removes every non-self assignee left over from a wedged claim, not just the first", async () => {
    vi.mocked(github.getStatusCommentInfo).mockResolvedValue({ createdAt: "2020-01-01T00:00:00.000Z" });

    await releaseStaleClaims(
      makeCtx(),
      project,
      [issue(1, ["fleet:in-progress"], { assignees: ["someone-else", "another-one"] })],
      "daemon-a",
    );

    expect(github.removeAssignee).toHaveBeenCalledWith(project, 1, "someone-else");
    expect(github.removeAssignee).toHaveBeenCalledWith(project, 1, "another-one");
  });

  it("is idempotent when a race with another observing daemon already released the ticket (unassign/ready are no-ops via gh)", async () => {
    vi.mocked(github.getStatusCommentInfo).mockResolvedValue({ createdAt: "2020-01-01T00:00:00.000Z" });

    await expect(
      releaseStaleClaims(makeCtx(), project, [issue(1, ["fleet:in-progress"], { assignees: ["someone-else"] })], "daemon-a"),
    ).resolves.toBeUndefined();
  });

  it("logs and continues rather than throwing when a step in the release fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(github.getStatusCommentInfo).mockResolvedValue({ createdAt: "2020-01-01T00:00:00.000Z" });
    vi.mocked(github.removeAssignee).mockRejectedValueOnce(new Error("gh: rate limited"));

    await expect(
      releaseStaleClaims(makeCtx(), project, [issue(1, ["fleet:in-progress"], { assignees: ["someone-else"] })], "daemon-a"),
    ).resolves.toBeUndefined();
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("could not finish releasing"))).toBe(true);

    errorSpy.mockRestore();
  });

  describe("Discord notifications", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
      vi.mocked(github.getStatusCommentInfo).mockResolvedValue({ createdAt: "2020-01-01T00:00:00.000Z" });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("posts a stale-released notification once the release succeeds", async () => {
      const config = makeFleetConfig({ projects: [project], notifications: { discordUrl: "https://discord.example/webhook" } });

      await releaseStaleClaims(makeCtx({ config }), project, [issue(1, ["fleet:in-progress"], { assignees: ["someone-else"] })], "daemon-a");

      expect(fetch).toHaveBeenCalledOnce();
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { content: string };
      expect(body.content).toContain("Stale claim released");
    });

    it("does not notify without notifications configured", async () => {
      await releaseStaleClaims(makeCtx(), project, [issue(1, ["fleet:in-progress"], { assignees: ["someone-else"] })], "daemon-a");

      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe("refreshOwnHeartbeats", () => {
  it("refreshes running and needs-input tickets, but not review/failed/stalled ones", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(makeRecord({ issueNumber: 1, status: "running" }));
    ctx.state.upsert(makeRecord({ issueNumber: 2, status: "needs-input" }));
    ctx.state.upsert(makeRecord({ issueNumber: 3, status: "review" }));
    ctx.state.upsert(makeRecord({ issueNumber: 4, status: "stalled" }));

    await refreshOwnHeartbeats(ctx);

    expect(github.refreshHeartbeatIfStale).toHaveBeenCalledTimes(2);
    const issueNumbers = vi.mocked(github.refreshHeartbeatIfStale).mock.calls.map((c) => c[1]);
    expect(issueNumbers.sort()).toEqual([1, 2]);
  });

  it("does nothing under --dry-run", async () => {
    const ctx = makeCtx({ dryRun: true });
    ctx.state.upsert(makeRecord({ issueNumber: 1, status: "running" }));

    await refreshOwnHeartbeats(ctx);

    expect(github.refreshHeartbeatIfStale).not.toHaveBeenCalled();
  });

  it("passes half the configured staleClaimMinutes as the max age", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(makeRecord({ issueNumber: 1, status: "running" }));

    await refreshOwnHeartbeats(ctx);

    expect(github.refreshHeartbeatIfStale).toHaveBeenCalledWith(project, 1, heartbeatRefreshAgeMs(ctx.config.staleClaimMinutes));
  });
});

describe("refreshStalledHeartbeatsOnBoot", () => {
  it("force-refreshes only stalled tickets", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(makeRecord({ issueNumber: 1, status: "stalled" }));
    ctx.state.upsert(makeRecord({ issueNumber: 2, status: "running" }));

    await refreshStalledHeartbeatsOnBoot(ctx);

    expect(github.refreshHeartbeat).toHaveBeenCalledTimes(1);
    expect(github.refreshHeartbeat).toHaveBeenCalledWith(project, 1);
  });

  it("does nothing under --dry-run", async () => {
    const ctx = makeCtx({ dryRun: true });
    ctx.state.upsert(makeRecord({ issueNumber: 1, status: "stalled" }));

    await refreshStalledHeartbeatsOnBoot(ctx);

    expect(github.refreshHeartbeat).not.toHaveBeenCalled();
  });
});
