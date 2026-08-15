import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import { machineReviewLine } from "./finish.ts";
import { FleetLoop } from "./loop.ts";
import type { MachineReviewOutcome } from "../session/review.ts";
import { StateStore } from "../store/state.ts";

vi.mock("../github/github.ts", () => ({
  createPullRequest: vi.fn(),
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

vi.mock("../github/worktree.ts", () => ({
  createWorktree: vi.fn(),
  hasCommits: vi.fn(async () => true),
  pushBranch: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  collectBranchDiff: vi.fn(async () => ({ diff: "diff --git a b", commits: "abc123 fix" })),
}));

vi.mock("../session/review.ts", async (importActual) => ({
  ...(await importActual<typeof import("../session/review.ts")>()),
  runMachineReview: vi.fn(),
}));

const github = await import("../github/github.ts");
const worktreeMod = await import("../github/worktree.ts");
const review = await import("../session/review.ts");

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
  machineReview: true,
  model: "claude-sonnet-5",
  lightModel: "claude-haiku-4-5",
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
const worktree = { path: "/tmp/wt/7", branch: "fleet/7" };

function makeLoop(seed?: TicketRecord, opts: { dryRun?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-machinereview-"));
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
    usageWindowHours: 5,
    budgetLightThreshold: 0.85,
    dataDir,
    projects: [project],
  };
  const approvals = { request: vi.fn() } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, opts.dryRun ?? false);
  const internals = loop as unknown as {
    machineReviewGate: (
      p: ProjectConfig,
      i: typeof issue,
      w: typeof worktree,
      base: { costUsd: number; modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }> },
    ) => Promise<{ action: "proceed" } | { action: "fixing"; prompt: string }>;
    resetForFreshClaim: (p: ProjectConfig, issueNumber: number) => Promise<void>;
  };
  return { loop, state, internals };
}

function reviewOutcome(patch: Partial<MachineReviewOutcome> = {}): MachineReviewOutcome {
  return { costUsd: 0.05, modelUsage: { "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5, costUsd: 0.05 } }, ...patch };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(worktreeMod.hasCommits).mockResolvedValue(true);
  vi.mocked(worktreeMod.collectBranchDiff).mockResolvedValue({ diff: "diff --git a b", commits: "abc123 fix" });
});

describe("machineReviewGate", () => {
  it("proceeds on a pass verdict and records the outcome and reviewer cost", async () => {
    vi.mocked(review.runMachineReview).mockResolvedValue(
      reviewOutcome({ result: { verdict: "pass", summary: "Looks correct.", findings: [] } }),
    );
    const { state, internals } = makeLoop(record());
    const base = { costUsd: 3 };

    const gate = await internals.machineReviewGate(project, issue, worktree, base);

    expect(gate).toEqual({ action: "proceed" });
    expect(review.runMachineReview).toHaveBeenCalledOnce();
    expect(vi.mocked(review.runMachineReview).mock.calls[0]?.[0]?.model).toBe("claude-haiku-4-5");
    expect(state.get("alpha", 7)?.machineReviewOutcome).toBe("passed");
    expect(base.costUsd).toBeCloseTo(3.05);
    expect(state.get("alpha", 7)?.costUsd).toBeCloseTo(3.05);
    expect(state.get("alpha", 7)?.modelUsage?.["claude-haiku-4-5"]?.costUsd).toBeCloseTo(0.05);
    expect(github.upsertStatusComment).not.toHaveBeenCalled();
  });

  it("returns a fix prompt on findings and posts them to the status comment", async () => {
    vi.mocked(review.runMachineReview).mockResolvedValue(
      reviewOutcome({
        result: {
          verdict: "findings",
          summary: "One problem.",
          findings: [{ file: "src/a.ts", line: 3, severity: "major", summary: "off-by-one", detail: "bound excludes last item" }],
        },
      }),
    );
    const { state, internals } = makeLoop(record());

    const gate = await internals.machineReviewGate(project, issue, worktree, { costUsd: 0 });

    expect(gate.action).toBe("fixing");
    if (gate.action === "fixing") expect(gate.prompt).toContain("off-by-one");
    expect(state.get("alpha", 7)?.machineReviewOutcome).toBe("findings");
    const comment = vi.mocked(github.upsertStatusComment).mock.calls[0]?.[2] ?? "";
    expect(comment).toContain("Machine review found 1 issue(s)");
    expect(comment).toContain("`src/a.ts:3` — off-by-one");
  });

  it("caps at one attempt: a recorded outcome skips the reviewer entirely", async () => {
    const { internals } = makeLoop(record({ machineReviewOutcome: "findings" }));

    const gate = await internals.machineReviewGate(project, issue, worktree, { costUsd: 0 });

    expect(gate).toEqual({ action: "proceed" });
    expect(review.runMachineReview).not.toHaveBeenCalled();
  });

  it("fails open on a reviewer error", async () => {
    vi.mocked(review.runMachineReview).mockResolvedValue(reviewOutcome({ result: undefined, errorSubtype: "timed out after 8 minutes" }));
    const { state, internals } = makeLoop(record());

    const gate = await internals.machineReviewGate(project, issue, worktree, { costUsd: 0 });

    expect(gate).toEqual({ action: "proceed" });
    expect(state.get("alpha", 7)?.machineReviewOutcome).toBe("skipped");
  });

  it("fails open when collecting the diff throws", async () => {
    vi.mocked(worktreeMod.collectBranchDiff).mockRejectedValue(new Error("git exploded"));
    const { state, internals } = makeLoop(record());

    const gate = await internals.machineReviewGate(project, issue, worktree, { costUsd: 0 });

    expect(gate).toEqual({ action: "proceed" });
    expect(review.runMachineReview).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.machineReviewOutcome).toBe("skipped");
  });

  it("extends the daemon pause when the reviewer hits the plan limit, and still proceeds", async () => {
    vi.mocked(review.runMachineReview).mockResolvedValue(
      reviewOutcome({ result: undefined, errorSubtype: "plan_limit", limitResetAt: "2026-07-27T12:00:00.000Z" }),
    );
    const { state, internals } = makeLoop(record());

    const gate = await internals.machineReviewGate(project, issue, worktree, { costUsd: 0 });

    expect(gate).toEqual({ action: "proceed" });
    expect(state.get("alpha", 7)?.machineReviewOutcome).toBe("skipped");
    expect(state.getPausedUntil()).toBe(new Date(Date.parse("2026-07-27T12:00:00.000Z") + 5 * 60_000).toISOString());
  });

  it("never runs when the project opts out", async () => {
    const optedOut: ProjectConfig = { ...project, machineReview: false };
    const { state, internals } = makeLoop(record());

    const gate = await internals.machineReviewGate(optedOut, issue, worktree, { costUsd: 0 });

    expect(gate).toEqual({ action: "proceed" });
    expect(review.runMachineReview).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.machineReviewOutcome).toBeUndefined();
  });

  it("never runs in dry-run mode", async () => {
    const { internals } = makeLoop(record(), { dryRun: true });

    const gate = await internals.machineReviewGate(project, issue, worktree, { costUsd: 0 });

    expect(gate).toEqual({ action: "proceed" });
    expect(review.runMachineReview).not.toHaveBeenCalled();
  });

  it("skips an empty branch — that's finishCompleted's blocked-guard territory", async () => {
    vi.mocked(worktreeMod.hasCommits).mockResolvedValue(false);
    const { state, internals } = makeLoop(record());

    const gate = await internals.machineReviewGate(project, issue, worktree, { costUsd: 0 });

    expect(gate).toEqual({ action: "proceed" });
    expect(review.runMachineReview).not.toHaveBeenCalled();
    expect(state.get("alpha", 7)?.machineReviewOutcome).toBeUndefined();
  });
});

describe("machineReviewLine", () => {
  it("maps each outcome to its status-comment line", () => {
    expect(machineReviewLine("passed")).toBe("Machine review: passed");
    expect(machineReviewLine("findings")).toContain("addressed in a fix round");
    expect(machineReviewLine("skipped")).toContain("skipped");
    expect(machineReviewLine("pending")).toContain("skipped");
    expect(machineReviewLine(undefined)).toBeUndefined();
  });
});

describe("resetForFreshClaim", () => {
  it("clears machineReviewOutcome so an operator restart earns a fresh review", async () => {
    const { state, internals } = makeLoop(record({ machineReviewOutcome: "passed" }));

    await internals.resetForFreshClaim(project, 7);

    expect(state.get("alpha", 7)?.machineReviewOutcome).toBeUndefined();
    expect(state.get("alpha", 7)?.status).toBe("restarting");
  });
});
