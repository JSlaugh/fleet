import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "./approvals.ts";
import { healStaleReadyLabels } from "./claim.ts";
import { FleetLoop } from "./loop.ts";
import type { LoopContext } from "./context.ts";
import { StateStore } from "./state.ts";
import type { ReadyIssue } from "./github.ts";

vi.mock("./github.ts", async (importActual) => ({
  ...(await importActual<typeof import("./github.ts")>()),
  listFleetIssues: vi.fn(async () => []),
  listIssueStates: vi.fn(async () => ({ open: new Set(), all: new Set() })),
  toBoardTicket: vi.fn(() => null),
  swapLabel: vi.fn(async () => {}),
}));

const github = await import("./github.ts");

function issue(number: number, labels: string[]): ReadyIssue & { url: string } {
  return { number, title: `issue ${number}`, body: "", labels, url: `https://github.com/acme/alpha/issues/${number}` };
}

const project: ProjectConfig = {
  name: "alpha",
  repoPath: "/repo/alpha",
  githubRepo: "acme/alpha",
  defaultBranch: "main",
  maxConcurrent: 5,
  maxInReview: 2,
  planChildrenReady: false,
  autoElevateOnFailure: true,
  autoAddressReviews: true,
  machineReview: false,
};

/** `dryRun: true` so cycleProject only logs what it would do — no real `gh`/git calls, no worktree/session mocking needed. */
function makeLoop(projectOverrides: Partial<ProjectConfig> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-claim-"));
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
    projects: [{ ...project, ...projectOverrides }],
  };
  const approvals = { request: vi.fn() } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, true);
  return { loop, state };
}

describe("cycleProject with maxInReview backpressure", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.mocked(github.listFleetIssues).mockReset();
  });

  function loggedLines(): string[] {
    return logSpy.mock.calls.map((call) => String(call[0]));
  }

  it("holds all claims once the review queue is at maxInReview, even with free maxConcurrent slots", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([
      issue(1, ["fleet:review"]),
      issue(2, ["fleet:review"]),
      issue(3, ["fleet:ready"]),
    ]);
    const { loop } = makeLoop({ maxInReview: 2, maxConcurrent: 5 });

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim"))).toBe(false);
    expect(loggedLines().some((l) => l.includes("alpha: 2 in review >= maxInReview 2 — holding claims"))).toBe(true);
  });

  it("claims only up to the remaining review capacity, not the full maxConcurrent slice", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([
      issue(1, ["fleet:review"]),
      issue(2, ["fleet:ready"]),
      issue(3, ["fleet:ready"]),
      issue(4, ["fleet:ready"]),
    ]);
    const { loop } = makeLoop({ maxInReview: 3, maxConcurrent: 5 });

    await loop.cycle();

    const claims = loggedLines().filter((l) => l.includes("would claim"));
    expect(claims).toHaveLength(2);
    expect(claims.some((l) => l.includes("alpha#2"))).toBe(true);
    expect(claims.some((l) => l.includes("alpha#3"))).toBe(true);
    expect(claims.some((l) => l.includes("alpha#4"))).toBe(false);
  });

  it("resumes claiming once a reviewed PR leaves fleet:review", async () => {
    const { loop } = makeLoop({ maxInReview: 2, maxConcurrent: 5 });

    vi.mocked(github.listFleetIssues).mockResolvedValueOnce([
      issue(1, ["fleet:review"]),
      issue(2, ["fleet:review"]),
      issue(3, ["fleet:ready"]),
    ]);
    await loop.cycle();
    expect(loggedLines().some((l) => l.includes("would claim"))).toBe(false);

    logSpy.mockClear();
    vi.mocked(github.listFleetIssues).mockResolvedValueOnce([issue(1, ["fleet:review"]), issue(3, ["fleet:ready"])]);
    await loop.cycle();
    expect(loggedLines().some((l) => l.includes("would claim alpha#3"))).toBe(true);
  });

  it("still checks review feedback for in-flight tickets while new claims are held", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([
      issue(1, ["fleet:review"]),
      issue(2, ["fleet:review"]),
      issue(3, ["fleet:ready"]),
    ]);
    const { loop } = makeLoop({ maxInReview: 2, maxConcurrent: 5 });

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would check alpha for PR review feedback"))).toBe(true);
  });
});

function ticketRecord(patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber: 62,
    issueTitle: "issue 62",
    branch: "fleet/62",
    worktreePath: "/tmp/wt/62",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 0,
    ...patch,
  };
}

describe("healStaleReadyLabels", () => {
  beforeEach(() => {
    vi.mocked(github.swapLabel).mockClear();
  });

  it("removes a stale fleet:ready label when the record already shows review with a PR", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fleet-heal-"));
    const state = new StateStore(dataDir);
    state.upsert(ticketRecord({ status: "review", prUrl: "https://github.com/acme/alpha/pull/72" }));
    const ctx = { state } as unknown as LoopContext;

    await healStaleReadyLabels(ctx, project, [issue(62, ["fleet:ready"])]);

    expect(github.swapLabel).toHaveBeenCalledWith(project, 62, "fleet:ready", "fleet:review");
  });

  it("does nothing when the issue isn't labeled fleet:ready", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fleet-heal-"));
    const state = new StateStore(dataDir);
    state.upsert(ticketRecord({ status: "review", prUrl: "https://github.com/acme/alpha/pull/72" }));
    const ctx = { state } as unknown as LoopContext;

    await healStaleReadyLabels(ctx, project, [issue(62, ["fleet:review"])]);

    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("does nothing when the record has no prUrl yet", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fleet-heal-"));
    const state = new StateStore(dataDir);
    state.upsert(ticketRecord({ status: "review" }));
    const ctx = { state } as unknown as LoopContext;

    await healStaleReadyLabels(ctx, project, [issue(62, ["fleet:ready"])]);

    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("does nothing when the labels themselves already carry the conflict (left for the label-consistency log instead)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fleet-heal-"));
    const state = new StateStore(dataDir);
    state.upsert(ticketRecord({ status: "review", prUrl: "https://github.com/acme/alpha/pull/72" }));
    const ctx = { state } as unknown as LoopContext;

    await healStaleReadyLabels(ctx, project, [issue(62, ["fleet:ready", "fleet:review"])]);

    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("does nothing when there's no record for the issue", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fleet-heal-"));
    const state = new StateStore(dataDir);
    const ctx = { state } as unknown as LoopContext;

    await healStaleReadyLabels(ctx, project, [issue(62, ["fleet:ready"])]);

    expect(github.swapLabel).not.toHaveBeenCalled();
  });
});
