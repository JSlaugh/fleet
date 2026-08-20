import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { Journal } from "../store/journal.ts";
import { FleetLoop } from "./loop.ts";

vi.mock("../github/github.ts", () => ({
  getPrOutcome: vi.fn(async () => undefined),
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
  removeWorktree: vi.fn(async () => ({ stdout: "", stderr: "" })),
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
  return { loop, state, internals, dataDir };
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

  it("archives the PR outcome fields fetched alongside prState", async () => {
    vi.mocked(github.getPrState).mockResolvedValue("MERGED");
    vi.mocked(github.getPrOutcome).mockResolvedValue({
      openedAt: "2026-01-01T00:00:00.000Z",
      mergedAt: "2026-01-02T00:00:00.000Z",
      timeToMergeMs: 24 * 60 * 60 * 1000,
      humanPushedAfterOpen: true,
      reviewRounds: 2,
      reviewCommentCount: 3,
    });
    const { loop, internals } = makeLoop(record());

    await internals.cleanupFinished(project, []);

    expect(github.getPrOutcome).toHaveBeenCalledWith(project, "https://github.com/acme/alpha/pull/7");
    const archived = loop.getHistoryRecord("alpha", 7);
    expect(archived?.timeToMergeMs).toBe(24 * 60 * 60 * 1000);
    expect(archived?.humanPushedAfterOpen).toBe(true);
    expect(archived?.reviewRounds).toBe(2);
    expect(archived?.reviewCommentCount).toBe(3);
  });

  it("still archives and cleans up when the PR outcome fetch fails, just without the enriched fields", async () => {
    vi.mocked(github.getPrState).mockResolvedValue("MERGED");
    vi.mocked(github.getPrOutcome).mockRejectedValue(new Error("gh: rate limited"));
    const { loop, state, internals } = makeLoop(record());

    await expect(internals.cleanupFinished(project, [])).resolves.toBeUndefined();

    expect(state.get("alpha", 7)).toBeUndefined();
    const archived = loop.getHistoryRecord("alpha", 7);
    expect(archived?.prState).toBe("MERGED");
    expect(archived?.timeToMergeMs).toBeUndefined();
  });

  it("archives bash-denied count and approval-latency stats summarized from the ticket's journal", async () => {
    vi.mocked(github.getPrState).mockResolvedValue("MERGED");
    const { dataDir, loop, internals } = makeLoop(record());
    const journal = new Journal(dataDir, "alpha", 7);
    journal.append({ type: "fleet", event: "bash-denied", command: "git push" });
    journal.append({ type: "fleet", event: "approval-decided", toolName: "Bash", outcome: "allowed", waitMs: 1000 });
    journal.append({ type: "fleet", event: "approval-decided", toolName: "Write", outcome: "denied", waitMs: 3000 });

    await internals.cleanupFinished(project, []);

    const archived = loop.getHistoryRecord("alpha", 7);
    expect(archived?.bashDeniedCount).toBe(1);
    expect(archived?.approvalLatency).toEqual({ count: 2, totalWaitMs: 4000, maxWaitMs: 3000 });
  });

  it("archives zeroed bash-denied/approval-latency stats when the journal has neither event", async () => {
    vi.mocked(github.getPrState).mockResolvedValue("MERGED");
    const { loop, internals } = makeLoop(record());

    await internals.cleanupFinished(project, []);

    const archived = loop.getHistoryRecord("alpha", 7);
    expect(archived?.bashDeniedCount).toBe(0);
    expect(archived?.approvalLatency).toEqual({ count: 0, totalWaitMs: 0, maxWaitMs: 0 });
  });

  it("does not fetch a PR outcome for a PR-less plan record", async () => {
    const { internals } = makeLoop(record({ isPlan: true, prUrl: undefined }));

    await internals.cleanupFinished(project, []);

    expect(github.getPrOutcome).not.toHaveBeenCalled();
  });

  it("still skips a non-plan record with no prUrl", async () => {
    const { state, internals } = makeLoop(record({ isPlan: false, prUrl: undefined }));

    await internals.cleanupFinished(project, []);

    expect(github.getPrState).not.toHaveBeenCalled();
    expect(worktreeMod.removeWorktree).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)).toBeDefined();
  });
});
