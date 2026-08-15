import type { FleetConfig, TicketRecord } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import type { LoopContext } from "./context.ts";
import {
  autoMergeReady,
  checksAreGreen,
  isApprovedForMerge,
  isMergeReady,
  latestReviewByAuthor,
  pickAutoMergeCandidates,
} from "./automerge.ts";
import { FleetLoop } from "./loop.ts";
import type { StateStore } from "../store/state.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  getPrReviews: vi.fn(),
  getPrChecks: vi.fn(),
  getPrMergeable: vi.fn(),
  getAuthenticatedLogin: vi.fn(async () => "daemon-user"),
  mergePullRequest: vi.fn(async () => {}),
  upsertStatusComment: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

const project = makeProject({ maxConcurrent: 2, autoMerge: true, approvers: ["alice"] });

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

function makeCtx(seed?: TicketRecord, configPatch: Partial<FleetConfig> = {}): { ctx: LoopContext; state: StateStore } {
  const { dataDir, state } = makeTempState("fleet-automerge-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project], ...configPatch });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
  const ctx = (loop as unknown as { ctx: LoopContext }).ctx;
  return { ctx, state };
}

const openIssues = new Set([7]);
const approved = [{ author: "alice", state: "APPROVED", submittedAt: "2026-01-02T00:00:00.000Z" }];
const noChecks: { name: string; bucket: string }[] = [];
const passingChecks = [{ name: "ci", bucket: "pass" }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(github.getAuthenticatedLogin).mockResolvedValue("daemon-user");
  vi.mocked(github.getPrReviews).mockResolvedValue(approved);
  vi.mocked(github.getPrChecks).mockResolvedValue(noChecks);
  vi.mocked(github.getPrMergeable).mockResolvedValue("MERGEABLE");
});

describe("pickAutoMergeCandidates", () => {
  it("picks review tickets with a PR when the project opts in", () => {
    expect(pickAutoMergeCandidates([record()], project, openIssues, []).map((r) => r.issueNumber)).toEqual([7]);
  });

  it("returns nothing when autoMerge is unset", () => {
    expect(pickAutoMergeCandidates([record()], { name: "alpha" }, openIssues, [])).toEqual([]);
  });

  it("skips tickets not in review", () => {
    expect(pickAutoMergeCandidates([record({ status: "running" })], project, openIssues, [])).toEqual([]);
  });

  it("skips tickets with no PR url", () => {
    expect(pickAutoMergeCandidates([record({ prUrl: undefined })], project, openIssues, [])).toEqual([]);
  });

  it("skips tickets whose issue is no longer open", () => {
    expect(pickAutoMergeCandidates([record({ issueNumber: 4 })], project, openIssues, [])).toEqual([]);
  });

  it("skips tickets already in flight", () => {
    expect(pickAutoMergeCandidates([record()], project, openIssues, ["alpha#7"])).toEqual([]);
  });

  it("ignores records from other projects", () => {
    expect(pickAutoMergeCandidates([record({ project: "beta" })], project, openIssues, [])).toEqual([]);
  });
});

describe("latestReviewByAuthor", () => {
  it("keeps only the most recent review per login, case-insensitively", () => {
    const reviews = [
      { author: "Alice", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T00:00:00.000Z" },
      { author: "alice", state: "APPROVED", submittedAt: "2026-01-02T00:00:00.000Z" },
    ];
    const latest = latestReviewByAuthor(reviews);
    expect(latest.size).toBe(1);
    expect(latest.get("alice")?.state).toBe("APPROVED");
  });
});

describe("isApprovedForMerge", () => {
  it("approves when an allowlisted login's latest review is APPROVED", () => {
    expect(isApprovedForMerge(approved, ["alice"])).toBe(true);
  });

  it("is case-insensitive on both the author and the allowlist", () => {
    expect(isApprovedForMerge([{ author: "Alice", state: "APPROVED", submittedAt: "t" }], ["ALICE"])).toBe(true);
  });

  it("rejects an approval from a non-allowlisted login", () => {
    expect(isApprovedForMerge(approved, ["bob"])).toBe(false);
  });

  it("rejects when there is no approval at all", () => {
    expect(isApprovedForMerge([], ["alice"])).toBe(false);
  });

  it("rejects when anyone has an outstanding changes-requested review, even a non-approver", () => {
    const reviews = [...approved, { author: "carol", state: "CHANGES_REQUESTED", submittedAt: "2026-01-03T00:00:00.000Z" }];
    expect(isApprovedForMerge(reviews, ["alice"])).toBe(false);
  });

  it("rejects when the approver's own later review requested changes", () => {
    const reviews = [
      { author: "alice", state: "APPROVED", submittedAt: "2026-01-02T00:00:00.000Z" },
      { author: "alice", state: "CHANGES_REQUESTED", submittedAt: "2026-01-03T00:00:00.000Z" },
    ];
    expect(isApprovedForMerge(reviews, ["alice"])).toBe(false);
  });
});

describe("checksAreGreen", () => {
  it("is green with zero checks reported", () => {
    expect(checksAreGreen([])).toBe(true);
  });

  it("is green when every check passed", () => {
    expect(checksAreGreen([{ name: "a", bucket: "pass" }, { name: "b", bucket: "skipping" }])).toBe(true);
  });

  it("is not green when a check is pending", () => {
    expect(checksAreGreen([{ name: "a", bucket: "pass" }, { name: "b", bucket: "pending" }])).toBe(false);
  });

  it("is not green when a check failed", () => {
    expect(checksAreGreen([{ name: "a", bucket: "fail" }])).toBe(false);
  });
});

describe("isMergeReady", () => {
  it("requires approval, green checks, and MERGEABLE together", () => {
    expect(isMergeReady({ reviews: approved, approvers: ["alice"], checks: noChecks, mergeable: "MERGEABLE" })).toBe(true);
    expect(isMergeReady({ reviews: approved, approvers: ["bob"], checks: noChecks, mergeable: "MERGEABLE" })).toBe(false);
    expect(isMergeReady({ reviews: approved, approvers: ["alice"], checks: [{ name: "a", bucket: "fail" }], mergeable: "MERGEABLE" })).toBe(false);
    expect(isMergeReady({ reviews: approved, approvers: ["alice"], checks: noChecks, mergeable: "CONFLICTING" })).toBe(false);
    expect(isMergeReady({ reviews: approved, approvers: ["alice"], checks: noChecks, mergeable: "UNKNOWN" })).toBe(false);
  });
});

describe("autoMergeReady", () => {
  it("merges an approved, green, mergeable PR and posts a status comment", async () => {
    const { ctx } = makeCtx(record());

    await autoMergeReady(ctx, project, openIssues);

    expect(github.mergePullRequest).toHaveBeenCalledWith(project, "https://github.com/acme/alpha/pull/7", "squash");
    expect(github.upsertStatusComment).toHaveBeenCalledWith(
      project,
      7,
      expect.stringContaining("merged automatically (approved by @alice, checks green)"),
    );
  });

  it("does nothing when the project has not opted in", async () => {
    const { ctx } = makeCtx(record());

    await autoMergeReady(ctx, { ...project, autoMerge: false }, openIssues);

    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("does not merge without an allowlisted approval", async () => {
    vi.mocked(github.getPrReviews).mockResolvedValue([]);
    const { ctx } = makeCtx(record());

    await autoMergeReady(ctx, project, openIssues);

    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("does not merge with an outstanding changes-requested review", async () => {
    vi.mocked(github.getPrReviews).mockResolvedValue([
      ...approved,
      { author: "carol", state: "CHANGES_REQUESTED", submittedAt: "2026-01-03T00:00:00.000Z" },
    ]);
    const { ctx } = makeCtx(record());

    await autoMergeReady(ctx, project, openIssues);

    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("does not merge with a pending check", async () => {
    vi.mocked(github.getPrChecks).mockResolvedValue([{ name: "ci", bucket: "pending" }]);
    const { ctx } = makeCtx(record());

    await autoMergeReady(ctx, project, openIssues);

    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("does not merge a PR reporting CONFLICTING or UNKNOWN mergeable state", async () => {
    vi.mocked(github.getPrMergeable).mockResolvedValue("CONFLICTING");
    const { ctx } = makeCtx(record());

    await autoMergeReady(ctx, project, openIssues);

    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("merges a PR with zero reported checks", async () => {
    vi.mocked(github.getPrChecks).mockResolvedValue(passingChecks);
    const { ctx } = makeCtx(record());

    await autoMergeReady(ctx, project, openIssues);

    expect(github.mergePullRequest).toHaveBeenCalledOnce();
  });

  it("resolves approvers to the gh-authenticated login when unset", async () => {
    vi.mocked(github.getPrReviews).mockResolvedValue([
      { author: "daemon-user", state: "APPROVED", submittedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    const { ctx } = makeCtx(record());

    await autoMergeReady(ctx, { ...project, approvers: undefined }, openIssues);

    expect(github.getAuthenticatedLogin).toHaveBeenCalledOnce();
    expect(github.mergePullRequest).toHaveBeenCalledOnce();
  });

  it("logs and retries next cycle when the merge attempt fails, without throwing", async () => {
    vi.mocked(github.mergePullRequest).mockRejectedValue(new Error("branch protection"));
    const { ctx } = makeCtx(record());

    await expect(autoMergeReady(ctx, project, openIssues)).resolves.toBeUndefined();

    expect(github.upsertStatusComment).not.toHaveBeenCalled();
  });

  it("does not merge and does not throw when fetching PR state fails", async () => {
    vi.mocked(github.getPrMergeable).mockRejectedValue(new Error("gh: rate limited"));
    const { ctx } = makeCtx(record());

    await expect(autoMergeReady(ctx, project, openIssues)).resolves.toBeUndefined();

    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  describe("Discord notifications", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
      vi.mocked(github.mergePullRequest).mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("posts an auto-merged notification once the merge succeeds", async () => {
      const { ctx } = makeCtx(record(), { notifications: { discordUrl: "https://discord.example/webhook" } });

      await autoMergeReady(ctx, project, openIssues);

      expect(fetch).toHaveBeenCalledOnce();
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { content: string };
      expect(body.content).toContain("Auto-merged");
      expect(body.content).toContain("https://github.com/acme/alpha/pull/7");
    });

    it("does not notify without notifications configured", async () => {
      const { ctx } = makeCtx(record());

      await autoMergeReady(ctx, project, openIssues);

      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
