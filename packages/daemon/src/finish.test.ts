import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "./approvals.ts";
import { FleetLoop } from "./loop.ts";
import { StateStore } from "./state.ts";

vi.mock("./github.ts", () => ({
  createPullRequest: vi.fn(async () => "https://github.com/acme/alpha/pull/7"),
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

vi.mock("./worktree.ts", () => ({
  createWorktree: vi.fn(),
  hasCommits: vi.fn(async () => true),
  pushBranch: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  collectBranchDiff: vi.fn(async () => ({ diff: "diff --git a b", commits: "abc123 fix" })),
}));

const github = await import("./github.ts");
const worktreeMod = await import("./worktree.ts");

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

const issue = { number: 7, title: "issue 7", body: "body", labels: [] };

function makeLoop(seed?: TicketRecord) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-finish-"));
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
    finishCompleted: (
      p: ProjectConfig,
      i: typeof issue,
      worktreePath: string,
      branch: string,
      summary: string,
      result: { prTitle?: string; prBody?: string; filesChanged: string[]; confidence: string },
    ) => Promise<void>;
    finishBlocked: (p: ProjectConfig, i: typeof issue, reason: string, summary?: string) => Promise<void>;
  };
  return { loop, state, internals };
}

const completedResult = { prTitle: "Fix the thing", prBody: "It's fixed.", filesChanged: ["src/a.ts"], confidence: "high" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(worktreeMod.hasCommits).mockResolvedValue(true);
  vi.mocked(github.createPullRequest).mockResolvedValue("https://github.com/acme/alpha/pull/7");
});

describe("finishCompleted — status comment error policy", () => {
  it("still reaches fleet:review and records the PR when the status comment fails", async () => {
    vi.mocked(github.upsertStatusComment).mockRejectedValue(new Error("gh: rate limited"));
    const { state, internals } = makeLoop(record());

    await internals.finishCompleted(project, issue, "/tmp/wt/7", "fleet/7", "did the thing", completedResult);

    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:review");
    const updated = state.get("alpha", 7);
    expect(updated?.status).toBe("review");
    expect(updated?.prUrl).toBe("https://github.com/acme/alpha/pull/7");
  });

  it("posts the review status comment and swaps the label on the happy path", async () => {
    const { state, internals } = makeLoop(record());

    await internals.finishCompleted(project, issue, "/tmp/wt/7", "fleet/7", "did the thing", completedResult);

    expect(github.upsertStatusComment).toHaveBeenCalledOnce();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:review");
    expect(state.get("alpha", 7)?.status).toBe("review");
  });
});

describe("finishBlocked — status comment error policy", () => {
  it("still reaches fleet:needs-input when the status comment fails", async () => {
    vi.mocked(github.upsertStatusComment).mockRejectedValue(new Error("gh: rate limited"));
    const { state, internals } = makeLoop(record());

    await internals.finishBlocked(project, issue, "need the API key", "summary");

    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    expect(state.get("alpha", 7)?.status).toBe("needs-input");
  });
});
