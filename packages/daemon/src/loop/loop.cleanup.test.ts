import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { FleetLoop } from "./loop.ts";

vi.mock("../github/github.ts", () => ({
  getPrState: vi.fn(),
  listFleetIssues: vi.fn(async () => []),
  swapLabel: vi.fn(async () => {}),
  toBoardTicket: vi.fn(),
  upsertStatusComment: vi.fn(async () => {}),
}));

vi.mock("../github/worktree.ts", () => ({
  createWorktree: vi.fn(),
  deleteRemoteBranch: vi.fn(async () => {}),
  hasCommits: vi.fn(async () => true),
  pushBranch: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  collectBranchDiff: vi.fn(async () => ({ diff: "", commits: "" })),
}));

vi.mock("../github/exec.ts", () => ({
  run: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

vi.mock("../store/transcripts.ts", () => ({
  copyTicketTranscripts: vi.fn(),
}));

const github = await import("../github/github.ts");
const worktreeMod = await import("../github/worktree.ts");
const execMod = await import("../github/exec.ts");
const transcriptsMod = await import("../store/transcripts.ts");

const project = makeProject();

function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    status: "review",
    costUsd: 1,
    prUrl: "https://github.com/acme/alpha/pull/7",
    ...patch,
  });
}

function makeLoop(seed?: TicketRecord) {
  const { dataDir, state } = makeTempState("fleet-cleanup-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
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
    expect(transcriptsMod.copyTicketTranscripts).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ project: "alpha", issueNumber: 7, worktreePath: "/tmp/wt/7" }),
    );
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

  it("cleans up a PR-less plan record once its issue closes, without checking PR state", async () => {
    const { state, internals } = makeLoop(record({ isPlan: true, prUrl: undefined }));

    await internals.cleanupFinished(project, []);

    expect(github.getPrState).not.toHaveBeenCalled();
    expect(worktreeMod.removeWorktree).toHaveBeenCalledWith(project, "/tmp/wt/7");
    expect(worktreeMod.deleteRemoteBranch).toHaveBeenCalledWith(project, "fleet/7");
    expect(state.get("alpha", 7)).toBeUndefined();
  });

  it("archives a PR-less plan record with prState NONE", async () => {
    const { loop, internals } = makeLoop(record({ isPlan: true, prUrl: undefined }));

    await internals.cleanupFinished(project, []);

    expect(loop.getHistoryRecord("alpha", 7)?.prState).toBe("NONE");
  });

  it("does not clean up a PR-less plan record while its issue is still open", async () => {
    const { state, internals } = makeLoop(record({ isPlan: true, prUrl: undefined }));

    await internals.cleanupFinished(project, [{ number: 7 }]);

    expect(worktreeMod.removeWorktree).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)).toBeDefined();
  });

  it("still skips a non-plan record with no prUrl", async () => {
    const { state, internals } = makeLoop(record({ isPlan: false, prUrl: undefined }));

    await internals.cleanupFinished(project, []);

    expect(github.getPrState).not.toHaveBeenCalled();
    expect(worktreeMod.removeWorktree).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)).toBeDefined();
  });
});
