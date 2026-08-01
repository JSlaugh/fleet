import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FleetConfig, ProjectConfig } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "./approvals.ts";
import { FleetLoop } from "./loop.ts";
import { StateStore } from "./state.ts";

vi.mock("./github.ts", async (importActual) => ({
  ...(await importActual<typeof import("./github.ts")>()),
  listFleetIssues: vi.fn(async () => [{ number: 7, title: "issue 7", body: "", labels: ["fleet:ready"] }]),
  listIssueStates: vi.fn(async () => ({ open: new Set([7]), all: new Set([7]) })),
  toBoardTicket: vi.fn(() => null),
}));

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

/** `dryRun: true` so cycleProject only logs what it would do — no real `gh`/git calls, no worktree/session mocking needed. */
function makeLoop() {
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
    dataDir,
    projects: [project],
  };
  const approvals = { request: vi.fn() } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, true);
  return { loop, state };
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
