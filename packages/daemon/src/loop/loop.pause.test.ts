import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeCtx, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { pausedProjectNames } from "./board.ts";
import { FleetLoop } from "./loop.ts";
import { isProjectPaused } from "./pause.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  listFleetIssues: vi.fn(async (project: ProjectConfig) => [
    {
      number: project.name === "alpha" ? 7 : 8,
      title: `issue on ${project.name}`,
      body: "",
      labels: ["fleet:ready"],
      author: "collab-author",
    },
  ]),
  listIssueStates: vi.fn(async () => ({ open: new Set([7, 8]), all: new Set([7, 8]) })),
  toBoardTicket: vi.fn(() => null),
  getPushCollaborators: vi.fn(async () => new Set(["collab-author"])),
  getAuthenticatedLogin: vi.fn(async () => "daemon-user"),
}));

// `FleetLoop.cycle()` runs the auth preflight probe (fleet#217) before the
// per-project loop on every call — stub it healthy so `cycle()` never spawns
// a real CLI session in this suite.
vi.mock("../session/review.ts", async (importActual) => ({
  ...(await importActual<typeof import("../session/review.ts")>()),
  runAuthProbe: vi.fn(async () => ({ healthy: true })),
}));

const github = await import("../github/github.ts");

const project = makeProject();

const beta = makeProject({ name: "beta", repoPath: "/repo/beta", githubRepo: "acme/beta" });

/** `dryRun: true` so cycleProject only logs what it would do — no real `gh`/git calls, no worktree/session mocking needed. */
function makeLoop(projects: ProjectConfig[] = [project]) {
  const { dataDir, state } = makeTempState("fleet-pause-");
  const config = makeFleetConfig({ dataDir, projects });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), true);
  return { loop, state, config };
}

function stalledRecord(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({ sessionId: "sess-62", status: "stalled", ...patch });
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
    const ctx = makeCtx({ state, config: makeFleetConfig({ projects: [project, beta] }) });
    expect(isProjectPaused(ctx, "alpha")).toBe(true);
    expect(isProjectPaused(ctx, "beta")).toBe(true);
  });

  it("board projection reports only configured, currently-paused project names", () => {
    const { state, config } = makeLoop([project, beta]);
    state.setProjectPaused("alpha", true);
    state.setProjectPaused("gamma", true); // stale — not in this config, must be filtered out
    const ctx = makeCtx({ state, config });

    expect(pausedProjectNames(ctx)).toEqual(["alpha"]);
  });
});
