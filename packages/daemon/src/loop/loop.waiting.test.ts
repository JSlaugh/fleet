import { FLEET_LABELS, type TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCtx, makeFleetConfig, makeIssue, makeProject, makeRecord } from "../test-support.ts";
import type { LoopContext } from "./context.ts";
import { finishWaiting, resolveWaitMinutes, waitCapReason } from "./finish.ts";
import { reply } from "./operator.ts";
import { supervise } from "./supervise.ts";
import { buildWaitNudge, pickWaitingDue, resumeWaiting } from "./waiting.ts";
import type { WorkerSession } from "../session/worker.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  swapLabel: vi.fn(async () => {}),
  upsertStatusComment: vi.fn(async () => {}),
}));

// The resume itself (getIssue, markWorking, a real SDK session) is out of
// scope: these tests only care whether, when and how a resume was started.
vi.mock("./runner.ts", async (importActual) => ({
  ...(await importActual<typeof import("./runner.ts")>()),
  resumeTicket: vi.fn(async () => {}),
}));

vi.mock("./budget.ts", async (importActual) => ({
  ...(await importActual<typeof import("./budget.ts")>()),
  computeBudgetGate: vi.fn(() => ({ level: "none", spentUsd: 0, windowHours: 5 })),
}));

vi.mock("./workHoursReserve.ts", async (importActual) => ({
  ...(await importActual<typeof import("./workHoursReserve.ts")>()),
  computeWorkHoursReserveGate: vi.fn(() => ({ active: false })),
}));

const github = await import("../github/github.ts");
const runner = await import("./runner.ts");
const budget = await import("./budget.ts");
const workHours = await import("./workHoursReserve.ts");

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const PAST = "2026-11-06T11:59:00.000Z";
const FUTURE = "2026-11-06T12:05:00.000Z";

function waiting(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({ status: "waiting", sessionId: "sess-1", resumeAt: PAST, waitReason: "CI on PR #9", ...patch });
}

function ctxWith(records: TicketRecord[], patch: Partial<LoopContext> = {}): LoopContext {
  const ctx = makeCtx({ config: makeFleetConfig({ projects: [makeProject({ maxConcurrent: 2 })] }), ...patch });
  for (const r of records) ctx.state.upsert(r);
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

describe("pickWaitingDue", () => {
  const project = { name: "alpha", maxConcurrent: 2 };

  it("picks a waiting ticket once resumeAt has passed", () => {
    expect(pickWaitingDue([waiting()], project, [], NOW)).toHaveLength(1);
  });

  it.each([
    { name: "resumeAt still in the future", record: waiting({ resumeAt: FUTURE }) },
    { name: "no resumeAt", record: waiting({ resumeAt: undefined }) },
    { name: "no session to resume", record: waiting({ sessionId: undefined }) },
    { name: "not waiting", record: waiting({ status: "needs-input" }) },
    { name: "another project", record: waiting({ project: "beta" }) },
  ])("skips a ticket with $name", ({ record }) => {
    expect(pickWaitingDue([record], project, [], NOW)).toEqual([]);
  });

  it("skips a ticket already in flight", () => {
    expect(pickWaitingDue([waiting()], project, ["alpha#62"], NOW)).toEqual([]);
  });

  it("caps at maxConcurrent minus running, oldest resumeAt first", () => {
    const records = [
      waiting({ issueNumber: 1, resumeAt: "2026-11-06T11:58:00.000Z" }),
      waiting({ issueNumber: 2, resumeAt: "2026-11-06T11:50:00.000Z" }),
    ];

    const picked = pickWaitingDue(records, project, ["alpha#99"], NOW);

    expect(picked.map((r) => r.issueNumber)).toEqual([2]);
  });

  it("honors activeRunning over the raw running count", () => {
    expect(pickWaitingDue([waiting()], project, ["alpha#98", "alpha#99"], NOW, 1)).toHaveLength(1);
  });
});

describe("resumeWaiting", () => {
  it("resumes a due ticket with the wait nudge and counts the resume", async () => {
    const ctx = ctxWith([waiting()]);

    resumeWaiting(ctx);
    await Promise.all(ctx.running.values());

    expect(runner.resumeTicket).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ name: "alpha" }),
      expect.objectContaining({ issueNumber: 62, sessionId: "sess-1" }),
      buildWaitNudge("CI on PR #9"),
      "wait-resume",
    );
    const record = ctx.state.get("alpha", 62);
    expect(record?.waitResumes).toBe(1);
    expect(record?.resumeAt).toBeUndefined();
  });

  it("does not resume before resumeAt", () => {
    const ctx = ctxWith([waiting({ resumeAt: FUTURE })]);

    resumeWaiting(ctx);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(ctx.state.get("alpha", 62)?.status).toBe("waiting");
  });

  it("respects maxConcurrent across already-running tickets", () => {
    const ctx = ctxWith([waiting()]);
    ctx.running.set("alpha#1", new Promise(() => {}));
    ctx.running.set("alpha#2", new Promise(() => {}));

    resumeWaiting(ctx);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
  });

  it.each([
    { name: "the auth gate is held", setup: (ctx: LoopContext) => void (ctx.authGateHeld = true) },
    { name: "the daemon is drained", setup: (ctx: LoopContext) => ctx.state.setPaused(true) },
    { name: "the project is paused", setup: (ctx: LoopContext) => ctx.state.setProjectPaused("alpha", true) },
    {
      name: "the budget gate is blocked",
      setup: () => void vi.mocked(budget.computeBudgetGate).mockReturnValueOnce({ level: "blocked", spentUsd: 9, budgetUsd: 8, windowHours: 5 }),
    },
    {
      name: "the work-hours reserve is active",
      setup: () => void vi.mocked(workHours.computeWorkHoursReserveGate).mockReturnValueOnce({ active: true }),
    },
  ])("holds while $name", ({ setup }) => {
    const ctx = ctxWith([waiting()]);
    setup(ctx);

    resumeWaiting(ctx);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(ctx.state.get("alpha", 62)?.waitResumes).toBeUndefined();
  });

  it.each([
    { name: "dry-run", patch: { dryRun: true } },
    { name: "a shutdown in progress", patch: { isShuttingDown: () => true } },
  ])("starts nothing under $name", ({ patch }) => {
    const ctx = ctxWith([waiting()], patch);

    resumeWaiting(ctx);

    expect(runner.resumeTicket).not.toHaveBeenCalled();
    expect(ctx.running.size).toBe(0);
    expect(ctx.state.get("alpha", 62)?.status).toBe("waiting");
  });
});

describe("finishWaiting", () => {
  const project = makeProject();
  const issue = makeIssue(62, [FLEET_LABELS.inProgress]);

  it("records waiting with a resumeAt, never touching the needs-input label", async () => {
    const ctx = ctxWith([makeRecord()]);

    const outcome = await finishWaiting(ctx, project, issue, { summary: "Kicked off the build.", waitReason: "nightly build", resumeAfterMinutes: 15 });

    expect(outcome).toEqual({ action: "scheduled", resumeAt: "2026-11-06T12:15:00.000Z" });
    expect(ctx.state.get("alpha", 62)).toMatchObject({
      status: "waiting",
      waitReason: "nightly build",
      waitReasons: ["nightly build"],
      resumeAt: "2026-11-06T12:15:00.000Z",
    });
    expect(github.swapLabel).not.toHaveBeenCalled();
    const comment = vi.mocked(github.upsertStatusComment).mock.calls[0]?.[2];
    expect(comment).toContain("**Status: waiting** — nightly build");
    expect(comment).toContain("2026-11-06T12:15:00.000Z");
  });

  it("falls back to exhausted, listing every wait, once maxWaitResumes resumes have happened", async () => {
    const ctx = ctxWith([makeRecord({ waitResumes: 3, waitReasons: ["a", "b", "c"] })]);

    const outcome = await finishWaiting(ctx, project, issue, { summary: "s", waitReason: "d" });

    expect(outcome).toEqual({ action: "exhausted", reason: waitCapReason(["a", "b", "c", "d"], 3) });
    expect(ctx.state.get("alpha", 62)).toMatchObject({ waitResumes: 0 });
    expect(ctx.state.get("alpha", 62)?.waitReasons).toBeUndefined();
    expect(ctx.state.get("alpha", 62)?.resumeAt).toBeUndefined();
    expect(github.upsertStatusComment).not.toHaveBeenCalled();
  });
});

describe("resolveWaitMinutes", () => {
  const config = { waitResumeDefaultMinutes: 10, waitResumeMaxMinutes: 60 };

  it.each([
    { name: "unset → default", requested: undefined, expected: 10 },
    { name: "within range", requested: 25, expected: 25 },
    { name: "over the max → clamped", requested: 600, expected: 60 },
  ])("$name", ({ requested, expected }) => {
    expect(resolveWaitMinutes(config, requested)).toBe(expected);
  });
});

describe("supervise on a waiting turn", () => {
  const project = makeProject();
  const issue = makeIssue(62, [FLEET_LABELS.inProgress]);
  const result = { status: "waiting" as const, summary: "s", filesChanged: [], confidence: "high" as const, waitReason: "CI" };

  function session(): WorkerSession {
    return {
      nextResult: vi.fn(async () => ({ kind: "code", result })),
      send: vi.fn(),
      costUsd: 0.5,
      sessionId: "sess-1",
      numTurns: 3,
    } as unknown as WorkerSession;
  }

  it("schedules the resume and ends the run without parking", async () => {
    const ctx = ctxWith([makeRecord()]);

    await supervise(ctx, project, issue, { path: "/tmp/wt/62", branch: "fleet/62" }, session(), { costUsd: 0 });

    expect(ctx.state.get("alpha", 62)?.status).toBe("waiting");
    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("parks as needs-input once the wait cap is hit", async () => {
    const ctx = ctxWith([makeRecord({ waitResumes: 3, waitReasons: ["a", "b", "c"] })], { once: true });

    await supervise(ctx, project, issue, { path: "/tmp/wt/62", branch: "fleet/62" }, session(), { costUsd: 0 });

    expect(github.swapLabel).toHaveBeenCalledWith(project, 62, FLEET_LABELS.inProgress, FLEET_LABELS.needsInput);
    expect(ctx.state.get("alpha", 62)).toMatchObject({ status: "needs-input", lastSummary: waitCapReason(["a", "b", "c", "CI"], 3) });
  });
});

describe("a human reply to a waiting ticket", () => {
  it("resumes it immediately and resets the wait streak", async () => {
    const ctx = ctxWith([waiting({ resumeAt: FUTURE, waitResumes: 2, waitReasons: ["a", "b"] })]);

    const outcome = await reply(ctx, "alpha", 62, "It's merged, carry on.");

    expect(outcome).toBe("resumed");
    expect(runner.resumeTicket).toHaveBeenCalledWith(ctx, expect.anything(), expect.anything(), "It's merged, carry on.", "operator-reply");
    expect(ctx.state.get("alpha", 62)).toMatchObject({ waitResumes: 0 });
    expect(ctx.state.get("alpha", 62)?.waitReasons).toBeUndefined();
    expect(ctx.state.get("alpha", 62)?.resumeAt).toBeUndefined();
  });
});
