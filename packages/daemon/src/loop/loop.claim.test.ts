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
}));

vi.mock("../github/worktree.ts", () => ({
  createWorktree: vi.fn(async () => ({ path: "/tmp/wt/62", branch: "fleet/62" })),
}));

vi.mock("./runner.ts", () => ({
  runSession: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

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
  it("sets the initial comment watermark to the claim moment, so pre-claim comments (already in the first prompt) are never re-injected", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

    await processTicket(ctx, project, issue(62, ["fleet:ready"]));

    const record = ctx.state.get("alpha", 62);
    expect(record?.lastCommentHandledAt).toBeDefined();
    expect(record?.lastCommentHandledAt).toBe(record?.startedAt);
  });
});
