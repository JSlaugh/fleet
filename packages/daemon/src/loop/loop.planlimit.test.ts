import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeCtx, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { FleetLoop } from "./loop.ts";
import { handleAuthFailure, pauseForAuthFailure } from "./pause.ts";

vi.mock("../github/github.ts", () => ({
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

const github = await import("../github/github.ts");

const project = makeProject();

/** This file's ticket is issue 7 throughout; keep a local wrapper with those defaults over the shared factory. */
function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    sessionId: "sess-7",
    costUsd: 3,
    ...patch,
  });
}

function makeLoop(seed?: TicketRecord, configPatch: Partial<FleetConfig> = {}) {
  const { dataDir, state } = makeTempState("fleet-planlimit-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project], ...configPatch });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
  const internals = loop as unknown as {
    handlePlanLimit: (p: ProjectConfig, issue: { number: number; title: string }, limitResetAt: string | undefined) => Promise<void>;
    isPaused: () => boolean;
    updatePauseState: () => void;
  };
  return { loop, state, internals };
}

/** `handleAuthFailure`/`pauseForAuthFailure` operate over a plain `LoopContext`, unlike `handlePlanLimit` above which is exercised through `FleetLoop`'s private wrapper. */
function makeCtxFor(seed?: TicketRecord, configPatch: Partial<FleetConfig> = {}) {
  const { dataDir, state } = makeTempState("fleet-authfailure-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project], ...configPatch });
  const ctx = makeCtx({ config, state });
  return { ctx, state };
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

  describe("Discord notifications", () => {
    const notifications = { discordUrl: "https://discord.example/webhook" };

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("posts a paused notification the first time a limit hit sets the pause", async () => {
      const { internals } = makeLoop(record(), { notifications });

      await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, "2026-01-01T00:00:00.000Z");

      expect(fetch).toHaveBeenCalledOnce();
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { content: string };
      expect(body.content).toContain("Paused");
    });

    it("does not re-notify when a later hit is already covered by the existing pause", async () => {
      const { internals } = makeLoop(record(), { notifications });

      await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, "2026-01-02T00:00:00.000Z");
      vi.mocked(fetch).mockClear();
      await internals.handlePlanLimit(project, { number: 7, title: "issue 7" }, "2026-01-01T00:00:00.000Z");

      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe("handleAuthFailure", () => {
  it("pauses the daemon via the operator-drain flag, with no reset time", async () => {
    const { ctx, state } = makeCtxFor(record());

    await handleAuthFailure(ctx, project, { number: 7, title: "issue 7" });

    expect(state.getPaused()).toBe(true);
    expect(state.getPausedUntil()).toBeUndefined();
  });

  it("does not mark the ticket failed — it goes stalled with the session preserved", async () => {
    const { ctx, state } = makeCtxFor(record({ status: "running", autoResumed: true }));

    await handleAuthFailure(ctx, project, { number: 7, title: "issue 7" });

    expect(github.swapLabel).not.toHaveBeenCalled();
    expect(github.escalateToElevated).not.toHaveBeenCalled();
    const updated = state.get("alpha", 7);
    expect(updated?.status).toBe("stalled");
    expect(updated?.sessionId).toBe("sess-7");
    // the once-only auto-resume guard must not carry over and block the pause-triggered resume
    expect(updated?.autoResumed).toBe(false);
    expect(updated?.lastActivityNote).toContain("authentication failure");
  });

  it("posts a status comment describing the pause", async () => {
    const { ctx } = makeCtxFor(record());

    await handleAuthFailure(ctx, project, { number: 7, title: "issue 7" });

    const commentBody = vi.mocked(github.upsertStatusComment).mock.calls[0]?.[2] ?? "";
    expect(commentBody).toContain("Authentication failure");
  });

  it("does not re-pause (or re-notify) once the daemon is already paused", async () => {
    const { ctx, state } = makeCtxFor(record());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    await handleAuthFailure(ctx, project, { number: 7, title: "issue 7" });
    expect(state.getPaused()).toBe(true);
    vi.mocked(fetch).mockClear();

    await handleAuthFailure(ctx, project, { number: 8, title: "issue 8" });

    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  describe("Discord notifications", () => {
    const notifications = { discordUrl: "https://discord.example/webhook" };

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("posts a paused notification the first time an auth failure sets the pause", async () => {
      const { ctx } = makeCtxFor(record(), { notifications });

      await handleAuthFailure(ctx, project, { number: 7, title: "issue 7" });

      expect(fetch).toHaveBeenCalledOnce();
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { content: string };
      expect(body.content).toContain("Paused");
    });
  });
});

describe("pauseForAuthFailure", () => {
  it("sets the daemon-wide pause without touching any ticket state", async () => {
    const { ctx, state } = makeCtxFor(record({ status: "running" }));

    pauseForAuthFailure(ctx, project, { number: 7, title: "issue 7" });

    expect(state.getPaused()).toBe(true);
    expect(state.get("alpha", 7)?.status).toBe("running");
  });

  it("invalidates the cached auth-probe result (fleet#217) so the next cycle re-probes instead of trusting a now-stale healthy cache", async () => {
    const { ctx } = makeCtxFor(record({ status: "running" }));
    ctx.authProbeCache = { healthy: true, checkedAt: Date.now() };

    pauseForAuthFailure(ctx, project, { number: 7, title: "issue 7" });

    expect(ctx.authProbeCache).toBeUndefined();
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
