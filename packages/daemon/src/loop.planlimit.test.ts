import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "./approvals.ts";
import { FleetLoop } from "./loop.ts";
import { StateStore } from "./state.ts";

vi.mock("./github.ts", () => ({
  createPullRequest: vi.fn(),
  escalateToElevated: vi.fn(async () => {}),
  getIssueComments: vi.fn(async () => []),
  getIssueLabels: vi.fn(async () => []),
  getPrFeedback: vi.fn(),
  getPrState: vi.fn(),
  listFleetIssues: vi.fn(async () => []),
  listIssueStates: vi.fn(async () => ({ open: new Set(), all: new Set() })),
  markReady: vi.fn(async () => {}),
  swapLabel: vi.fn(async () => {}),
  toBoardTicket: vi.fn(),
  upsertStatusComment: vi.fn(async () => {}),
}));

const github = await import("./github.ts");

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

function makeLoop(seed?: TicketRecord) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-planlimit-"));
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
    handlePlanLimit: (p: ProjectConfig, issue: { number: number; title: string }, limitResetAt: string | undefined) => Promise<void>;
    isPaused: () => boolean;
    updatePauseState: () => void;
  };
  return { loop, state, internals };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handlePlanLimit", () => {
  it("pauses the daemon until the parsed reset time plus slack", async () => {
    const { state, internals } = makeLoop(record());

    await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, "2026-01-01T00:00:00.000Z");

    expect(state.getPausedUntil()).toBe(new Date(Date.parse("2026-01-01T00:00:00.000Z") + 5 * 60_000).toISOString());
  });

  it("falls back to the configured default backoff when no reset time was parsed", async () => {
    const { state, internals } = makeLoop(record());
    const before = Date.now();

    await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, undefined);

    const pausedUntil = Date.parse(state.getPausedUntil() as string);
    // default backoff (300m) + slack (5m), allowing generous slack for test execution time
    expect(pausedUntil).toBeGreaterThanOrEqual(before + 304 * 60_000);
    expect(pausedUntil).toBeLessThanOrEqual(before + 306 * 60_000);
  });

  it("does not mark the ticket failed — it goes stalled with the session preserved", async () => {
    const { state, internals } = makeLoop(record({ status: "running", autoResumed: true }));

    await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, "2026-01-01T00:00:00.000Z");

    expect(github.swapLabel).not.toHaveBeenCalled();
    const updated = state.get("alpha", 7);
    expect(updated?.status).toBe("stalled");
    expect(updated?.sessionId).toBe("sess-7");
    // the once-only auto-resume guard must not carry over and block the pause-triggered resume
    expect(updated?.autoResumed).toBe(false);
    expect(updated?.lastActivityNote).toContain("paused: plan limit until");
  });

  it("posts a status comment describing the pause", async () => {
    const { internals } = makeLoop(record());

    await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, "2026-01-01T00:00:00.000Z");

    const commentBody = vi.mocked(github.upsertStatusComment).mock.calls[0]?.[2] ?? "";
    expect(commentBody).toContain("Plan usage limit reached");
  });

  it("extends an existing pause when a second, later limit hit arrives", async () => {
    const { state, internals } = makeLoop(record());

    await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, "2026-01-01T00:00:00.000Z");
    const first = state.getPausedUntil();

    await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, "2026-01-02T00:00:00.000Z");
    const second = state.getPausedUntil();

    expect(Date.parse(second as string)).toBeGreaterThan(Date.parse(first as string));
  });

  it("does not shrink an existing pause when a second, earlier-resolving limit hit arrives", async () => {
    const { state, internals } = makeLoop(record());

    await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, "2026-01-02T00:00:00.000Z");
    const first = state.getPausedUntil();

    await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, "2026-01-01T00:00:00.000Z");
    const second = state.getPausedUntil();

    expect(second).toBe(first);
  });
});

describe("isPaused / updatePauseState", () => {
  it("is not paused when no pause is recorded", () => {
    const { internals } = makeLoop();
    expect(internals.isPaused()).toBe(false);
  });

  it("is paused while now is before pausedUntil", () => {
    const { state, internals } = makeLoop();
    state.setPausedUntil(new Date(Date.now() + 60_000).toISOString());
    expect(internals.isPaused()).toBe(true);
  });

  it("is not paused once pausedUntil has passed", () => {
    const { state, internals } = makeLoop();
    state.setPausedUntil(new Date(Date.now() - 1000).toISOString());
    expect(internals.isPaused()).toBe(false);
  });

  it("clears an expired pause", () => {
    const { state, internals } = makeLoop();
    state.setPausedUntil(new Date(Date.now() - 1000).toISOString());

    internals.updatePauseState();

    expect(state.getPausedUntil()).toBeUndefined();
  });

  it("leaves a still-active pause alone", () => {
    const { state, internals } = makeLoop();
    const stillActive = new Date(Date.now() + 60_000).toISOString();
    state.setPausedUntil(stillActive);

    internals.updatePauseState();

    expect(state.getPausedUntil()).toBe(stillActive);
  });
});
