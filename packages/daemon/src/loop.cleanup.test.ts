import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "./approvals.ts";
import { FleetLoop } from "./loop.ts";
import { StateStore } from "./state.ts";

vi.mock("./github.ts", () => ({
  getPrState: vi.fn(),
  listFleetIssues: vi.fn(async () => []),
  swapLabel: vi.fn(async () => {}),
  toBoardTicket: vi.fn(),
  upsertStatusComment: vi.fn(async () => {}),
}));

vi.mock("./worktree.ts", () => ({
  createWorktree: vi.fn(),
  deleteRemoteBranch: vi.fn(async () => {}),
  hasCommits: vi.fn(async () => true),
  pushBranch: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  collectBranchDiff: vi.fn(async () => ({ diff: "", commits: "" })),
}));

vi.mock("./exec.ts", () => ({
  run: vi.fn(async () => ({ stdout: "" })),
}));

const github = await import("./github.ts");
const worktreeMod = await import("./worktree.ts");
const execMod = await import("./exec.ts");

const project: ProjectConfig = {
  name: "alpha",
  repoPath: "/repo/alpha",
  githubRepo: "acme/alpha",
  defaultBranch: "main",
  maxConcurrent: 1,
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
    status: "review",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 1,
    prUrl: "https://github.com/acme/alpha/pull/7",
    ...patch,
  };
}

function makeLoop(seed?: TicketRecord) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-cleanup-"));
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
    cleanupFinished: (p: ProjectConfig, openIssues: { number: number }[]) => Promise<void>;
  };
  return { loop, state, internals };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cleanupFinished", () => {
  it("deletes the remote branch alongside the worktree and local branch once merged and closed", async () => {
    vi.mocked(github.getPrState).mockResolvedValue("MERGED");
    const { state, internals } = makeLoop(record());

    await internals.cleanupFinished(project, []);

    expect(worktreeMod.removeWorktree).toHaveBeenCalledWith(project, "/tmp/wt/7");
    expect(execMod.run).toHaveBeenCalledWith("git", ["-C", project.repoPath, "branch", "-D", "fleet/7"], { allowFailure: true });
    expect(worktreeMod.deleteRemoteBranch).toHaveBeenCalledWith(project, "fleet/7");
    expect(state.get("alpha", 7)).toBeUndefined();
  });

  it("also cleans up a closed (not merged) PR", async () => {
    vi.mocked(github.getPrState).mockResolvedValue("CLOSED");
    const { internals } = makeLoop(record());

    await internals.cleanupFinished(project, []);

    expect(worktreeMod.deleteRemoteBranch).toHaveBeenCalledWith(project, "fleet/7");
  });

  it("does not clean up while the issue is still open", async () => {
    vi.mocked(github.getPrState).mockResolvedValue("MERGED");
    const { state, internals } = makeLoop(record());

    await internals.cleanupFinished(project, [{ number: 7 }]);

    expect(worktreeMod.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)).toBeDefined();
  });

  it("does not clean up while the PR is still open", async () => {
    vi.mocked(github.getPrState).mockResolvedValue("OPEN");
    const { internals } = makeLoop(record());

    await internals.cleanupFinished(project, []);

    expect(worktreeMod.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(worktreeMod.removeWorktree).not.toHaveBeenCalled();
  });

  it("a missing remote branch (deleteRemoteBranch failing internally) does not block cleanup", async () => {
    vi.mocked(github.getPrState).mockResolvedValue("MERGED");
    vi.mocked(worktreeMod.deleteRemoteBranch).mockResolvedValue(undefined);
    const { state, internals } = makeLoop(record());

    await expect(internals.cleanupFinished(project, [])).resolves.toBeUndefined();

    expect(state.get("alpha", 7)).toBeUndefined();
  });
});
