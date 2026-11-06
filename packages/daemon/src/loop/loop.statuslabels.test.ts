import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardTicket } from "@fleet/shared";
import { makeCtx, makeFleetConfig, makeIssue, makeProject, makeRecord } from "../test-support.ts";

// The single-status-label invariant (fleet#239). `exec.run` is mocked with a
// tiny label simulator so `gh issue edit` args are applied to a real label
// set — the assertion is on the labels the issue ends with, not on argv.
vi.mock("../github/exec.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/exec.ts")>()),
  run: vi.fn(async (_cmd: string, args: string[]) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--remove-label") labels.delete(args[i + 1]!);
      if (args[i] === "--add-label") labels.add(args[i + 1]!);
    }
    return "";
  }),
}));

vi.mock("@fleet/github", async (importActual) => ({
  ...(await importActual<typeof import("@fleet/github")>()),
  listFleetIssues: vi.fn(async () => []),
}));

let labels = new Set<string>();

const exec = await import("../github/exec.ts");
const fleetGithub = await import("@fleet/github");
const { markWorking } = await import("./context.ts");
const { getBoard } = await import("./board.ts");
const { repairStatusLabels, resolveStatusLabelConflict } = await import("./labelRepair.ts");

const project = makeProject();

beforeEach(() => {
  vi.mocked(exec.run).mockClear();
});

describe("markWorking", () => {
  it("from ready+elevate leaves only in-progress plus the tier and priority labels, in one edit", async () => {
    labels = new Set(["fleet:ready", "fleet:elevate", "fleet:p2"]);
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(makeRecord({ status: "failed", autoElevated: true }));

    await markWorking(ctx, project, 62);

    expect([...labels].sort()).toEqual(["fleet:elevate", "fleet:in-progress", "fleet:p2"]);
    expect(exec.run).toHaveBeenCalledTimes(1);
    expect(ctx.state.get("alpha", 62)?.status).toBe("running");
  });

  it.each(["fleet:needs-input", "fleet:review", "fleet:backlog"])("replaces %s rather than adding beside it", async (from) => {
    labels = new Set([from, "fleet:light"]);

    await markWorking(makeCtx(), project, 62);

    expect([...labels].sort()).toEqual(["fleet:in-progress", "fleet:light"]);
  });
});

describe("getBoard", () => {
  const readyTicket = (): BoardTicket => ({
    project: "alpha",
    issueNumber: 62,
    title: "t",
    url: "",
    status: "ready",
    priority: null,
    type: null,
    isPlan: false,
  });

  it.each([
    { name: "its record is running", setup: (ctx: ReturnType<typeof makeCtx>) => ctx.state.upsert(makeRecord({ status: "running" })) },
    { name: "it is in flight", setup: (ctx: ReturnType<typeof makeCtx>) => ctx.running.set("alpha#62", new Promise(() => {})) },
  ])("shows a ticket labeled ready as in-progress when $name", ({ setup }) => {
    const ctx = makeCtx();
    ctx.boardCache.set("alpha", [readyTicket()]);
    setup(ctx);

    const [ticket] = getBoard(ctx);

    expect(ticket?.status).toBe("in-progress");
  });

  it("keeps the label status for a ticket that isn't running", () => {
    const ctx = makeCtx();
    ctx.boardCache.set("alpha", [readyTicket()]);
    ctx.state.upsert(makeRecord({ status: "failed" }));

    expect(getBoard(ctx)[0]?.status).toBe("ready");
  });
});

describe("resolveStatusLabelConflict", () => {
  it.each([
    { name: "a single status label", labels: ["fleet:ready", "fleet:elevate"], record: undefined, expected: undefined },
    { name: "a running record", labels: ["fleet:ready", "fleet:in-progress"], record: makeRecord({ status: "running" }), expected: "fleet:in-progress" },
    { name: "a stalled record", labels: ["fleet:ready", "fleet:in-progress"], record: makeRecord({ status: "stalled" }), expected: "fleet:in-progress" },
    { name: "a failed record", labels: ["fleet:ready", "fleet:needs-input"], record: makeRecord({ status: "failed" }), expected: "fleet:needs-input" },
    { name: "a review record", labels: ["fleet:ready", "fleet:review"], record: makeRecord({ status: "review" }), expected: "fleet:review" },
    { name: "a restarting record", labels: ["fleet:ready", "fleet:in-progress"], record: makeRecord({ status: "restarting" }), expected: "fleet:ready" },
    { name: "no record (keeps the most advanced)", labels: ["fleet:ready", "fleet:in-progress"], record: undefined, expected: "fleet:in-progress" },
  ])("resolves $name", ({ labels: issueLabels, record, expected }) => {
    expect(resolveStatusLabelConflict(issueLabels, record)).toBe(expected);
  });
});

describe("repairStatusLabels", () => {
  it("normalizes a conflicting issue from its record, logs once, and leaves clean issues alone", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    labels = new Set(["fleet:ready", "fleet:in-progress", "fleet:elevate", "fleet:p2"]);
    vi.mocked(fleetGithub.listFleetIssues).mockResolvedValueOnce([
      makeIssue(62, [...labels]),
      makeIssue(63, ["fleet:ready"]),
    ]);
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(makeRecord({ status: "stalled" }));

    await repairStatusLabels(ctx);

    expect([...labels].sort()).toEqual(["fleet:elevate", "fleet:in-progress", "fleet:p2"]);
    expect(exec.run).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.filter((c) => String(c[0]).includes("normalized"))).toHaveLength(1);
    logSpy.mockRestore();
  });

  it("changes nothing under --dry-run", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fleetGithub.listFleetIssues).mockResolvedValueOnce([makeIssue(62, ["fleet:ready", "fleet:in-progress"])]);
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }), dryRun: true });

    await repairStatusLabels(ctx);

    expect(exec.run).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
