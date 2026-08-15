import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import { pausedProjectNames } from "./board.ts";
import { FleetLoop } from "./loop.ts";
import { isProjectPaused } from "./pause.ts";
import type { LoopContext } from "./context.ts";
import { StateStore } from "../store/state.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  listFleetIssues: vi.fn(async (project: ProjectConfig) => [
    { number: project.name === "alpha" ? 7 : 8, title: `issue on ${project.name}`, body: "", labels: ["fleet:ready"] },
  ]),
  listIssueStates: vi.fn(async () => ({ open: new Set([7, 8]), all: new Set([7, 8]) })),
  toBoardTicket: vi.fn(() => null),
}));

const github = await import("../github/github.ts");

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
  autoMerge: false,
  mergeMethod: "squash",
};

const beta: ProjectConfig = { ...project, name: "beta", repoPath: "/repo/beta", githubRepo: "acme/beta" };

/** `dryRun: true` so cycleProject only logs what it would do — no real `gh`/git calls, no worktree/session mocking needed. */
function makeLoop(projects: ProjectConfig[] = [project]) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-pause-"));
  const state = new StateStore(dataDir);
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
    usageWindowHours: 5,
    budgetLightThreshold: 0.85,
    dataDir,
    projects,
  };
  const approvals = { request: vi.fn() } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, true);
  return { loop, state, config };
}

function stalledRecord(patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber: 62,
    issueTitle: "issue 62",
    branch: "fleet/62",
    worktreePath: "/tmp/wt/62",
    sessionId: "sess-62",
    status: "stalled",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 0,
    ...patch,
  };
}

describe("FleetLoop.cycle with an operator pause", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function loggedLines(): string[] {
    return logSpy.mock.calls.map((call) => String(call[0]));
  }

  it("claims nothing across two cycles while paused, then resumes claiming once unpaused", async () => {
    const { loop, state } = makeLoop();
    loop.setPaused(true);
    expect(state.getPaused()).toBe(true);

    await loop.cycle();
    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim"))).toBe(false);
    expect(loggedLines().some((l) => l.includes("PR review feedback"))).toBe(false);

    loop.setPaused(false);
    expect(state.getPaused()).toBe(false);
    logSpy.mockClear();

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim alpha#7"))).toBe(true);
  });
});

describe("FleetLoop.cycle with a per-project pause", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function loggedLines(): string[] {
    return logSpy.mock.calls.map((call) => String(call[0]));
  }

  it("holds claims for the paused project only — the other project claims as normal", async () => {
    const { loop, state } = makeLoop([project, beta]);
    loop.setProjectPaused("alpha", true);
    expect(state.isProjectPaused("alpha")).toBe(true);
    expect(state.isProjectPaused("beta")).toBe(false);

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim alpha#7"))).toBe(false);
    expect(loggedLines().some((l) => l.includes("would claim beta#8"))).toBe(true);
  });

  it("resumes claiming for that project once unpaused", async () => {
    const { loop } = makeLoop([project, beta]);
    loop.setProjectPaused("alpha", true);
    await loop.cycle();
    logSpy.mockClear();

    loop.setProjectPaused("alpha", false);
    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim alpha#7"))).toBe(true);
  });

  it("still runs board polling and cleanup for a paused project", async () => {
    vi.mocked(github.listFleetIssues).mockClear();
    const { loop } = makeLoop([project]);
    loop.setProjectPaused("alpha", true);

    await loop.cycle();

    expect(github.listFleetIssues).toHaveBeenCalledWith(project);
    expect(loggedLines().some((l) => l.includes("would clean up finished tickets for alpha"))).toBe(true);
  });

  it("does not auto-resume a stalled ticket in a paused project, but does in an unpaused one", async () => {
    const { loop, state } = makeLoop([project, beta]);
    state.upsert(stalledRecord({ project: "alpha", issueNumber: 62 }));
    state.upsert(stalledRecord({ project: "beta", issueNumber: 63 }));
    loop.setProjectPaused("alpha", true);
    logSpy.mockClear();

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would auto-resume stalled alpha#62"))).toBe(false);
    expect(loggedLines().some((l) => l.includes("would auto-resume stalled beta#63"))).toBe(true);
  });

  it("global pause overrides and covers every project regardless of per-project state", () => {
    const { loop, state } = makeLoop([project, beta]);
    loop.setPaused(true);
    const ctx = { state, config: { projects: [project, beta] } } as unknown as LoopContext;
    expect(isProjectPaused(ctx, "alpha")).toBe(true);
    expect(isProjectPaused(ctx, "beta")).toBe(true);
  });

  it("board projection reports only configured, currently-paused project names", () => {
    const { state, config } = makeLoop([project, beta]);
    state.setProjectPaused("alpha", true);
    state.setProjectPaused("gamma", true); // stale — not in this config, must be filtered out
    const ctx = { state, config } as unknown as LoopContext;

    expect(pausedProjectNames(ctx)).toEqual(["alpha"]);
  });
});
