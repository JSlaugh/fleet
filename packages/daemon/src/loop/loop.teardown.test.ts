import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { readJournalTail } from "../store/journal.ts";
import type { LoopContext } from "./context.ts";
import { FleetLoop } from "./loop.ts";
import { recoverPendingTeardowns, teardownTicket } from "./teardown.ts";

vi.mock("../github/github.ts", () => ({
  createPullRequest: vi.fn(),
  getIssueComments: vi.fn(async () => []),
  getIssueLabels: vi.fn(async () => []),
  getPrOutcome: vi.fn(async () => undefined),
  getPrState: vi.fn(),
  listFleetIssues: vi.fn(async () => []),
  markReady: vi.fn(async () => {}),
  swapLabel: vi.fn(async () => {}),
  toBoardTicket: vi.fn(),
  upsertStatusComment: vi.fn(async () => {}),
  clearAssignees: vi.fn(async () => {}),
  closeIssue: vi.fn(async () => {}),
  closePullRequest: vi.fn(async () => {}),
}));

vi.mock("../github/worktree.ts", () => ({
  createWorktree: vi.fn(),
  deleteRemoteBranch: vi.fn(async () => {}),
  hasCommits: vi.fn(async () => true),
  pushBranch: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => ({ stdout: "", stderr: "" })),
  collectBranchDiff: vi.fn(async () => ({ diff: "", commits: "" })),
  runTeardown: vi.fn(async () => ({ failures: [] })),
}));

const worktreeMod = await import("../github/worktree.ts");

const project = makeProject();

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-teardown-wt-"));
  dirs.push(dir);
  return dir;
}

/** A worktree path that is guaranteed not to exist. */
function goneWorktreePath(): string {
  return join(tmpdir(), "fleet-teardown-gone", `nope-${process.pid}`);
}

function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: goneWorktreePath(),
    costUsd: 1,
    ...patch,
  });
}

function makeLoop(seed?: TicketRecord) {
  const { dataDir, state } = makeTempState("fleet-teardown-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
  const internals = loop as unknown as {
    ctx: LoopContext;
    resetForFreshClaim: (p: ProjectConfig, issueNumber: number) => Promise<void>;
  };
  return { loop, state, internals, dataDir };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(worktreeMod.runTeardown).mockResolvedValue({ failures: [] });
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("teardownTicket", () => {
  it("is a total no-op when the record has no pending teardown", async () => {
    const seed = record();
    const { internals } = makeLoop(seed);

    await teardownTicket(internals.ctx, project, seed);

    expect(worktreeMod.runTeardown).not.toHaveBeenCalled();
  });

  it("runs teardown, journals the attempt, and clears the flag", async () => {
    vi.mocked(worktreeMod.runTeardown).mockResolvedValue({ failures: ['teardown step "boom" failed: exit 3'] });
    const seed = record({ teardownPending: true, ticketType: "api" });
    const { internals, state, dataDir } = makeLoop(seed);

    await teardownTicket(internals.ctx, project, seed);

    expect(worktreeMod.runTeardown).toHaveBeenCalledWith(project, 7, seed.worktreePath, "api");
    expect(state.get("alpha", 7)?.teardownPending).toBe(false);
    const events = readJournalTail(dataDir, "alpha", 7, 10).map((e) => e.event);
    expect(events).toContain("teardown-started");
    expect(events).toContain("teardown-completed");
  });

  it("still clears the flag when the teardown runner itself throws — best-effort, never retried into a loop", async () => {
    vi.mocked(worktreeMod.runTeardown).mockRejectedValue(new Error("docker exploded"));
    const seed = record({ teardownPending: true });
    const { internals, state } = makeLoop(seed);

    await expect(teardownTicket(internals.ctx, project, seed)).resolves.toBeUndefined();

    expect(state.get("alpha", 7)?.teardownPending).toBe(false);
  });
});

describe("recoverPendingTeardowns", () => {
  it("runs the pending teardown of a record whose worktree directory is already gone", async () => {
    const seed = record({ teardownPending: true, ticketType: "api" });
    const { internals, state } = makeLoop(seed);

    await recoverPendingTeardowns(internals.ctx);

    expect(worktreeMod.runTeardown).toHaveBeenCalledWith(project, 7, seed.worktreePath, "api");
    expect(state.get("alpha", 7)?.teardownPending).toBe(false);
  });

  it("leaves a record whose worktree still exists for its normal removal path", async () => {
    const seed = record({ teardownPending: true, worktreePath: makeTempDir() });
    const { internals, state } = makeLoop(seed);

    await recoverPendingTeardowns(internals.ctx);

    expect(worktreeMod.runTeardown).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.teardownPending).toBe(true);
  });

  it("does nothing when no record is flagged", async () => {
    const { internals } = makeLoop(record());

    await recoverPendingTeardowns(internals.ctx);

    expect(worktreeMod.runTeardown).not.toHaveBeenCalled();
  });
});

describe("resetForFreshClaim teardown", () => {
  it("tears down the previous attempt's resources as part of the operator restart", async () => {
    const seed = record({ teardownPending: true, ticketType: "api" });
    const { internals, state } = makeLoop(seed);

    await internals.resetForFreshClaim(project, 7);

    expect(worktreeMod.runTeardown).toHaveBeenCalledWith(project, 7, seed.worktreePath, "api");
    expect(state.get("alpha", 7)?.teardownPending).toBe(false);
    expect(state.get("alpha", 7)?.status).toBe("restarting");
  });

  it("restarts without any teardown when the claim never flagged one", async () => {
    const { internals, state } = makeLoop(record());

    await internals.resetForFreshClaim(project, 7);

    expect(worktreeMod.runTeardown).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.status).toBe("restarting");
  });
});
