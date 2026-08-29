import type { FleetConfig, ProjectConfig, WorkHoursReserveConfig } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeCtx, makeFleetConfig, makeIssue, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { applyContributorFloor, healStaleReadyLabels, processTicket, selectCollaboratorAuthored } from "./claim.ts";
import { FleetLoop } from "./loop.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  listFleetIssues: vi.fn(async () => []),
  listIssueStates: vi.fn(async () => ({ open: new Set(), all: new Set() })),
  toBoardTicket: vi.fn(() => null),
  swapLabel: vi.fn(async () => {}),
  getIssueComments: vi.fn(async () => []),
  // `makeIssue`'s default author is "collab-author" — this keeps existing
  // claim-flow tests passing the contributor floor without opting in per test.
  getPushCollaborators: vi.fn(async () => new Set(["collab-author"])),
  getAuthenticatedLogin: vi.fn(async () => "daemon-user"),
  getIssue: vi.fn(async () => undefined),
  addAssignee: vi.fn(async () => {}),
  removeAssignee: vi.fn(async () => {}),
  // Sole assignee by default — every existing claim-flow test wins its CAS
  // without opting in, same as the collaborator floor default above.
  getIssueAssignees: vi.fn(async () => ["daemon-user"]),
}));

vi.mock("../github/worktree.ts", () => ({
  createWorktree: vi.fn(async () => ({ path: "/tmp/wt/62", branch: "fleet/62" })),
  runTeardown: vi.fn(async () => ({ failures: [] })),
}));

vi.mock("./runner.ts", () => ({
  runSession: vi.fn(async () => {}),
}));

// `FleetLoop.cycle()` runs the auth preflight probe (fleet#217) before the
// per-project loop on every call — stub it healthy so `cycle()` never spawns
// a real CLI session in this suite.
vi.mock("../session/review.ts", async (importActual) => ({
  ...(await importActual<typeof import("../session/review.ts")>()),
  runAuthProbe: vi.fn(async () => ({ healthy: true })),
}));

const github = await import("../github/github.ts");
const worktree = await import("../github/worktree.ts");
const runner = await import("./runner.ts");
const review = await import("../session/review.ts");

const issue = makeIssue;
const project = makeProject({ maxConcurrent: 5, maxInReview: 2 });

/** `dryRun: true` so cycleProject only logs what it would do — no real `gh`/git calls, no worktree/session mocking needed. */
function makeLoop(projectOverrides: Partial<ProjectConfig> = {}, configOverrides: Partial<FleetConfig> = {}) {
  const { dataDir, state } = makeTempState("fleet-claim-");
  const config = makeFleetConfig({
    dataDir,
    projects: [{ ...project, ...projectOverrides }],
    ...configOverrides,
  });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), true);
  return { loop, state };
}

/**
 * `dryRun: false` variant for tests that need cycleProject's real (not
 * dry-run-logged) side effects — with no seeded state and an empty issue
 * list, every gh-shelling helper it calls (releaseStaleClaims,
 * addressComments, addressReviews, autoMergeReady, cleanupFinished,
 * healStaleReadyLabels) is a no-op before it ever reaches `gh`, so this stays
 * safe under the same github.ts mocks as the dry-run tests above.
 */
function makeLiveLoop(projectOverrides: Partial<ProjectConfig> = {}, configOverrides: Partial<FleetConfig> = {}) {
  const { dataDir, state } = makeTempState("fleet-claim-live-");
  const config = makeFleetConfig({
    dataDir,
    projects: [{ ...project, ...projectOverrides }],
    ...configOverrides,
  });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
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

  it("performs no assignee mutations under --dry-run, even for an otherwise-claimable ready issue", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"])]);
    const { loop } = makeLoop();

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim alpha#1"))).toBe(true);
    expect(github.addAssignee).not.toHaveBeenCalled();
    expect(github.removeAssignee).not.toHaveBeenCalled();
  });
});

describe("cycleProject budget gate", () => {
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

  it("claims normally when windowBudgetUsd is unset — feature off", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"])]);
    const { loop, state } = makeLoop();
    state.appendSpend(1000, 5); // would blow past any budget if the gate were on

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim alpha#1"))).toBe(true);
  });

  it("claims normally under the light threshold", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"])]);
    const { loop, state } = makeLoop({}, { windowBudgetUsd: 10 });
    state.appendSpend(5, 5); // under 0.85 * 10

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim alpha#1"))).toBe(true);
  });

  it("restricts claims to fleet:light once spend passes the light threshold", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"]), issue(2, ["fleet:ready", "fleet:light"])]);
    const { loop, state } = makeLoop({}, { windowBudgetUsd: 10 });
    state.appendSpend(9, 5); // >= 0.85 * 10

    await loop.cycle();

    const claims = loggedLines().filter((l) => l.includes("would claim"));
    expect(claims.some((l) => l.includes("alpha#1"))).toBe(false);
    expect(claims.some((l) => l.includes("alpha#2"))).toBe(true);
    expect(loggedLines().some((l) => l.includes("claiming fleet:light only"))).toBe(true);
  });

  it("holds all claims once spend reaches the budget", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready", "fleet:light"])]);
    const { loop, state } = makeLoop({}, { windowBudgetUsd: 10 });
    state.appendSpend(10, 5);

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim"))).toBe(false);
    expect(loggedLines().some((l) => l.includes("holding all claims"))).toBe(true);
  });

  describe("Discord notifications", () => {
    beforeEach(() => {
      vi.mocked(github.listFleetIssues).mockResolvedValue([]);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("posts a paused notification the first time the budget gate blocks a cycle", async () => {
      const { loop, state } = makeLiveLoop({}, { windowBudgetUsd: 10, notifications: { discordUrl: "https://discord.example/webhook" } });
      state.appendSpend(10, 5);

      await loop.cycle();

      expect(fetch).toHaveBeenCalledOnce();
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { content: string };
      expect(body.content).toContain("Paused");
      expect(body.content).toContain("holding all claims");
    });

    it("does not re-notify on a later cycle while the same block persists", async () => {
      const { loop, state } = makeLiveLoop({}, { windowBudgetUsd: 10, notifications: { discordUrl: "https://discord.example/webhook" } });
      state.appendSpend(10, 5);

      await loop.cycle();
      vi.mocked(fetch).mockClear();
      await loop.cycle();

      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe("cycleProject work-hours reserve", () => {
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

  // Spans a full day-plus, so it always contains "now" regardless of when this test runs.
  const ALWAYS_ACTIVE_RESERVE: WorkHoursReserveConfig = {
    workStart: "23:59",
    reserveHours: 25,
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
  };
  // windowStart == workStart, so the interval is empty and never contains "now".
  const NEVER_ACTIVE_RESERVE: WorkHoursReserveConfig = {
    workStart: "09:00",
    reserveHours: 0,
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
  };

  it("claims normally when workHoursReserve is unset — feature off", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"])]);
    const { loop } = makeLoop();

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim alpha#1"))).toBe(true);
  });

  it("claims normally when configured but the reserve window isn't active", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"])]);
    const { loop } = makeLoop({}, { workHoursReserve: NEVER_ACTIVE_RESERVE });

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim alpha#1"))).toBe(true);
  });

  it("holds all claims while the reserve window is active", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"])]);
    const { loop } = makeLoop({}, { workHoursReserve: ALWAYS_ACTIVE_RESERVE });

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim"))).toBe(false);
    expect(loggedLines().some((l) => l.includes("alpha: work-hours reserve active — holding claims until"))).toBe(true);
  });

  it("still checks review feedback for in-flight tickets while the reserve holds new claims", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"])]);
    const { loop } = makeLoop({}, { workHoursReserve: ALWAYS_ACTIVE_RESERVE });

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would check alpha for PR review feedback"))).toBe(true);
  });
});

describe("cycleProject auth gate (fleet#217)", () => {
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

  it("claims normally when the auth probe reports healthy", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"])]);
    const { loop } = makeLoop();

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim alpha#1"))).toBe(true);
  });

  it("holds all claims, with no worktree created and no label swap, when the auth probe reports unhealthy", async () => {
    vi.mocked(review.runAuthProbe).mockResolvedValueOnce({ healthy: false });
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"])]);
    const { loop } = makeLiveLoop();

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim") || l.includes("claiming alpha#1"))).toBe(false);
    expect(loggedLines().some((l) => l.includes("auth gate held — holding claims"))).toBe(true);
    expect(worktree.createWorktree).not.toHaveBeenCalled();
    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  // Automatic recovery once a later probe comes back healthy — with no
  // operator action — and the once-per-spell dedup across repeated held
  // cycles are both covered at the `checkAuthGate` unit level
  // (loop.authgate.test.ts), where the probe cache can be forced stale
  // directly instead of racing the real 15-minute TTL through `loop.cycle()`.
});

describe("cycleProject contributor floor", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(github.getPushCollaborators).mockClear();
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.mocked(github.listFleetIssues).mockReset();
  });

  function loggedLines(): string[] {
    return logSpy.mock.calls.map((call) => String(call[0]));
  }

  it("does not claim a ready issue authored by a non-collaborator", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"], { author: "mallory" })]);
    const { loop } = makeLoop();

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim"))).toBe(false);
    expect(loggedLines().some((l) => l.includes("alpha#1") && l.includes("@mallory") && l.includes("not a repo collaborator"))).toBe(
      true,
    );
  });

  it("applies the same floor to a fleet:plan issue", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:plan", "fleet:ready"], { author: "mallory" })]);
    const { loop } = makeLoop();

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim"))).toBe(false);
  });

  it("claims a collaborator-authored issue normally, including one authored by the operator's own bot account", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"], { author: "collab-author" })]);
    const { loop } = makeLoop();

    await loop.cycle();

    expect(loggedLines().some((l) => l.includes("would claim alpha#1"))).toBe(true);
  });

  it("checks collaborators once per cycle, not once per ready issue", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([
      issue(1, ["fleet:ready"], { author: "collab-author" }),
      issue(2, ["fleet:ready"], { author: "collab-author" }),
      issue(3, ["fleet:ready"], { author: "mallory" }),
    ]);
    const { loop } = makeLoop();

    await loop.cycle();

    expect(github.getPushCollaborators).toHaveBeenCalledTimes(1);
  });

  it("does not re-log an already-skipped issue on a later cycle", async () => {
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"], { author: "mallory" })]);
    const { loop } = makeLoop();

    await loop.cycle();
    expect(loggedLines().some((l) => l.includes("not a repo collaborator"))).toBe(true);

    logSpy.mockClear();
    await loop.cycle();
    expect(loggedLines().some((l) => l.includes("not a repo collaborator"))).toBe(false);
  });

  it("holds all claims for the project when the collaborator lookup fails, and retries next cycle", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(github.getPushCollaborators).mockRejectedValueOnce(new Error("gh: rate limited"));
    vi.mocked(github.listFleetIssues).mockResolvedValue([issue(1, ["fleet:ready"], { author: "collab-author" })]);
    const { loop } = makeLoop();

    await loop.cycle();
    expect(loggedLines().some((l) => l.includes("would claim"))).toBe(false);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("could not verify issue authors"))).toBe(true);

    errorSpy.mockRestore();
    logSpy.mockClear();
    await loop.cycle();
    expect(loggedLines().some((l) => l.includes("would claim alpha#1"))).toBe(true);
  });
});

describe("selectCollaboratorAuthored", () => {
  it("keeps an issue authored by a push collaborator", () => {
    const picked = selectCollaboratorAuthored([issue(1, ["fleet:ready"], { author: "alice" })], new Set(["alice"]), {
      projectName: "alpha",
      alreadyLogged: new Set(),
    });
    expect(picked.map((i) => i.number)).toEqual([1]);
  });

  it("excludes an issue authored by a non-collaborator", () => {
    const picked = selectCollaboratorAuthored([issue(1, ["fleet:ready"], { author: "mallory" })], new Set(["alice"]), {
      projectName: "alpha",
      alreadyLogged: new Set(),
    });
    expect(picked).toEqual([]);
  });

  it("logs a skip only the first time a given issue is seen", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const alreadyLogged = new Set<string>();
    const opts = { projectName: "alpha", alreadyLogged };

    selectCollaboratorAuthored([issue(1, ["fleet:ready"], { author: "mallory" })], new Set(["alice"]), opts);
    expect(logSpy).toHaveBeenCalledTimes(1);

    selectCollaboratorAuthored([issue(1, ["fleet:ready"], { author: "mallory" })], new Set(["alice"]), opts);
    expect(logSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});

describe("applyContributorFloor", () => {
  beforeEach(() => {
    vi.mocked(github.getPushCollaborators).mockClear();
  });

  it("skips the collaborator lookup entirely when there are no issues to check", async () => {
    const ctx = makeCtx();

    const picked = await applyContributorFloor(ctx, project, []);

    expect(picked).toEqual([]);
    expect(github.getPushCollaborators).not.toHaveBeenCalled();
  });

  it("holds all issues and logs an error when the lookup fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(github.getPushCollaborators).mockRejectedValueOnce(new Error("gh: rate limited"));
    const ctx = makeCtx();

    const picked = await applyContributorFloor(ctx, project, [issue(1, ["fleet:ready"], { author: "collab-author" })]);

    expect(picked).toEqual([]);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("could not verify issue authors"))).toBe(true);
    errorSpy.mockRestore();
  });
});

const reviewRecord = () => makeRecord({ status: "review", prUrl: "https://github.com/acme/alpha/pull/72" });

describe("healStaleReadyLabels", () => {
  beforeEach(() => {
    vi.mocked(github.swapLabel).mockClear();
  });

  it("removes a stale fleet:ready label when the record already shows review with a PR", async () => {
    const ctx = makeCtx();
    ctx.state.upsert(reviewRecord());

    await healStaleReadyLabels(ctx, project, [issue(62, ["fleet:ready"])]);

    expect(github.swapLabel).toHaveBeenCalledWith(project, 62, "fleet:ready", "fleet:review");
  });

  it.each([
    { name: "the issue isn't labeled fleet:ready", record: reviewRecord(), labels: ["fleet:review"] },
    { name: "the record has no prUrl yet", record: makeRecord({ status: "review" }), labels: ["fleet:ready"] },
    {
      name: "the labels themselves already carry the conflict (left for the label-consistency log instead)",
      record: reviewRecord(),
      labels: ["fleet:ready", "fleet:review"],
    },
    { name: "there's no record for the issue", record: undefined, labels: ["fleet:ready"] },
  ])("does nothing when $name", async ({ record, labels }) => {
    const ctx = makeCtx();
    if (record) ctx.state.upsert(record);

    await healStaleReadyLabels(ctx, project, [issue(62, labels)]);

    expect(github.swapLabel).not.toHaveBeenCalled();
  });
});

describe("processTicket", () => {
  beforeEach(() => {
    vi.mocked(github.swapLabel).mockClear();
    vi.mocked(github.addAssignee).mockClear();
    vi.mocked(github.removeAssignee).mockClear();
    vi.mocked(github.getIssueAssignees).mockReset().mockResolvedValue(["daemon-user"]);
    vi.mocked(worktree.createWorktree).mockClear();
  });

  /** The CAS delay is real `setTimeout` — fake timers so tests don't actually wait ~2.5s. */
  async function runProcessTicket(ctx: Parameters<typeof processTicket>[0], proj = project, iss = issue(62, ["fleet:ready"])) {
    vi.useFakeTimers();
    try {
      const result = processTicket(ctx, proj, iss);
      await vi.advanceTimersByTimeAsync(3_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  }

  it("sets the initial comment watermark to the claim moment, so pre-claim comments (already in the first prompt) are never re-injected", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

    await runProcessTicket(ctx);

    const record = ctx.state.get("alpha", 62);
    expect(record?.lastCommentHandledAt).toBeDefined();
    expect(record?.lastCommentHandledAt).toBe(record?.startedAt);
  });

  it("self-assigns before verifying the claim", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

    await runProcessTicket(ctx);

    expect(github.addAssignee).toHaveBeenCalledWith(project, 62, "daemon-user");
  });

  it("proceeds to claim normally when it's the sole assignee after the verify delay", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

    await runProcessTicket(ctx);

    expect(ctx.state.get("alpha", 62)?.status).toBe("running");
    expect(github.removeAssignee).not.toHaveBeenCalled();
  });

  it("abandons the claim, unassigns itself, and never creates a worktree when it loses the collision tiebreak", async () => {
    vi.mocked(github.getIssueAssignees).mockResolvedValue(["daemon-user", "alice"]);
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

    await runProcessTicket(ctx);

    expect(github.removeAssignee).toHaveBeenCalledWith(project, 62, "daemon-user");
    expect(worktree.createWorktree).not.toHaveBeenCalled();
    // Abandoned before any state record was ever written for this ticket.
    expect(ctx.state.get("alpha", 62)).toBeUndefined();
    // The loser must not touch the label — the winner (running the same
    // check) owns fleet:in-progress from here.
    expect(github.swapLabel).toHaveBeenCalledTimes(1);
  });

  it("wins the collision tiebreak and proceeds when its login sorts lowest", async () => {
    vi.mocked(github.getIssueAssignees).mockResolvedValue(["daemon-user", "zeta"]);
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

    await runProcessTicket(ctx);

    expect(github.removeAssignee).not.toHaveBeenCalled();
    expect(ctx.state.get("alpha", 62)?.status).toBe("running");
  });

  describe("ticket type", () => {
    beforeEach(() => {
      vi.mocked(runner.runSession).mockClear();
    });

    it("leaves ticketType undefined when createWorktree resolves no type", async () => {
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

      await runProcessTicket(ctx);

      expect(ctx.state.get("alpha", 62)?.ticketType).toBeUndefined();
      const call = vi.mocked(runner.runSession).mock.calls[0]?.[1] as { ticketType?: string } | undefined;
      expect(call?.ticketType).toBeUndefined();
    });

    it("records the matched type on the TicketRecord and passes it through to runSession", async () => {
      vi.mocked(worktree.createWorktree).mockResolvedValueOnce({ path: "/tmp/wt/62", branch: "fleet/62", type: "backend" });
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

      await runProcessTicket(ctx);

      expect(ctx.state.get("alpha", 62)?.ticketType).toBe("backend");
      const call = vi.mocked(runner.runSession).mock.calls[0]?.[1] as { ticketType?: string } | undefined;
      expect(call?.ticketType).toBe("backend");
    });
  });

  describe("per-worktree teardown", () => {
    it("flags teardownPending when the selected profile declares teardown steps", async () => {
      vi.mocked(worktree.createWorktree).mockResolvedValueOnce({ path: "/tmp/wt/62", branch: "fleet/62", type: "api", hasTeardown: true });
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

      await runProcessTicket(ctx);

      expect(ctx.state.get("alpha", 62)?.teardownPending).toBe(true);
    });

    it("tears down the previous attempt's flagged resources before the new worktree replaces it", async () => {
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
      ctx.state.upsert(makeRecord({ issueNumber: 62, worktreePath: "/tmp/wt/62-old", ticketType: "api", teardownPending: true, status: "failed" }));

      await runProcessTicket(ctx);

      expect(worktree.runTeardown).toHaveBeenCalledWith(expect.objectContaining({ name: "alpha" }), 62, "/tmp/wt/62-old", "api");
      const teardownOrder = vi.mocked(worktree.runTeardown).mock.invocationCallOrder[0] ?? 0;
      const createOrder = vi.mocked(worktree.createWorktree).mock.invocationCallOrder[0] ?? 0;
      expect(teardownOrder).toBeLessThan(createOrder);
      // The fresh claim's profile declared no teardown, so the stale flag does not survive the re-claim.
      expect(ctx.state.get("alpha", 62)?.teardownPending).toBeUndefined();
    });
  });

  describe("epic linkage", () => {
    beforeEach(() => {
      vi.mocked(github.getIssue).mockReset().mockResolvedValue(undefined);
      vi.mocked(runner.runSession).mockClear();
    });

    it("does not fetch an epic or set epicNumber for a plain ticket", async () => {
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

      await runProcessTicket(ctx);

      expect(github.getIssue).not.toHaveBeenCalled();
      expect(ctx.state.get("alpha", 62)?.epicNumber).toBeUndefined();
    });

    it("records epicNumber from a Part-of body line even if the epic fetch fails", async () => {
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
      const childIssue = issue(62, ["fleet:ready"], { body: "Part-of: #7" });

      await runProcessTicket(ctx, project, childIssue);

      expect(ctx.state.get("alpha", 62)?.epicNumber).toBe(7);
    });

    it("degrades to no epic context in the prompt when the epic fetch fails", async () => {
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
      const childIssue = issue(62, ["fleet:ready"], { body: "Part-of: #7" });

      await runProcessTicket(ctx, project, childIssue);

      const call = vi.mocked(runner.runSession).mock.calls[0]?.[1] as { firstMessage: string } | undefined;
      expect(call?.firstMessage).not.toContain("Part of epic");
    });

    it("prepends epic context to the first prompt when the epic fetch succeeds", async () => {
      vi.mocked(github.getIssue).mockResolvedValue({
        number: 7,
        title: "the epic",
        body: ["epic description", "", "## Children", "- [ ] #62 child ticket"].join("\n"),
        labels: [],
      });
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
      const childIssue = issue(62, ["fleet:ready"], { body: "Part-of: #7" });

      await runProcessTicket(ctx, project, childIssue);

      expect(github.getIssue).toHaveBeenCalledWith(project, 7);
      const call = vi.mocked(runner.runSession).mock.calls[0]?.[1] as { firstMessage: string } | undefined;
      expect(call?.firstMessage).toContain("This ticket is part of epic #7: the epic — ticket 1 of 1.");
    });
  });

  describe("prior-attempt context", () => {
    beforeEach(() => {
      vi.mocked(runner.runSession).mockClear();
    });

    it("omits the prior-attempt block on a genuinely first claim", async () => {
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

      await runProcessTicket(ctx);

      const call = vi.mocked(runner.runSession).mock.calls[0]?.[1] as { firstMessage: string } | undefined;
      expect(call?.firstMessage).not.toContain("Prior attempt");
    });

    it("folds a prior failure's lastSummary into the fresh prompt on an auto-elevated re-claim", async () => {
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
      ctx.state.upsert(
        makeRecord({
          issueNumber: 62,
          status: "failed",
          lastSummary: "Could not find the config file referenced in the issue.",
          autoElevated: true,
        }),
      );

      await runProcessTicket(ctx);

      const call = vi.mocked(runner.runSession).mock.calls[0]?.[1] as { firstMessage: string } | undefined;
      expect(call?.firstMessage).toContain("## Prior attempt");
      expect(call?.firstMessage).toContain("Could not find the config file referenced in the issue.");
      // The once-only escalation guard must still be carried forward alongside it.
      expect(ctx.state.get("alpha", 62)?.autoElevated).toBe(true);
    });

    it("prefers the preserved priorAttemptSummary over restart boilerplate on a restart re-claim", async () => {
      const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
      ctx.state.upsert(
        makeRecord({
          issueNumber: 62,
          status: "restarting",
          lastSummary: "Restarted from the dashboard — a fresh session will pick this up.",
          priorAttemptSummary: "Was mid-way through wiring up the new endpoint when it stalled.",
        }),
      );

      await runProcessTicket(ctx);

      const call = vi.mocked(runner.runSession).mock.calls[0]?.[1] as { firstMessage: string } | undefined;
      expect(call?.firstMessage).toContain("Was mid-way through wiring up the new endpoint when it stalled.");
      expect(call?.firstMessage).not.toContain("Restarted from the dashboard");
    });
  });
});
