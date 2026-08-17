import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCtx, makeFleetConfig, makeIssue, makeProject } from "../test-support.ts";
import { closeFinishedEpics, epicCloseDecision } from "./epics.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  closeIssue: vi.fn(async () => {}),
  upsertStatusComment: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

const project = makeProject();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("epicCloseDecision", () => {
  it("does not close an epic with no filed children", () => {
    expect(epicCloseDecision([], new Set())).toEqual({ shouldClose: false, closedCount: 0, totalCount: 0 });
  });

  it("does not close while any child is still open", () => {
    const decision = epicCloseDecision([{ number: 41 }, { number: 42 }], new Set([42]));
    expect(decision).toEqual({ shouldClose: false, closedCount: 1, totalCount: 2 });
  });

  it("closes once every child is closed", () => {
    const decision = epicCloseDecision([{ number: 41 }, { number: 42 }], new Set());
    expect(decision).toEqual({ shouldClose: true, closedCount: 2, totalCount: 2 });
  });
});

describe("closeFinishedEpics", () => {
  function epicIssue(patch: Partial<{ body: string; labels: string[] }> = {}) {
    return makeIssue(7, ["fleet:review", "fleet:plan"], {
      title: "epic 7",
      body: ["## Children", "- [ ] #41 add the field", "- [ ] #42 use the field"].join("\n"),
      ...patch,
    });
  }

  it("closes the epic once every child is closed, merged or abandoned alike", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

    await closeFinishedEpics(ctx, project, [epicIssue()], new Set());

    expect(github.closeIssue).toHaveBeenCalledWith(project, 7);
    expect(github.upsertStatusComment).toHaveBeenCalledWith(
      project,
      7,
      expect.stringContaining("all 2 child tickets are closed (merged or abandoned)"),
    );
  });

  it("leaves the epic open while any child is still open", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

    await closeFinishedEpics(ctx, project, [epicIssue()], new Set([41]));

    expect(github.closeIssue).not.toHaveBeenCalled();
    expect(github.upsertStatusComment).not.toHaveBeenCalled();
  });

  it("ignores a non-plan issue even if it happens to carry a Children-shaped body", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    const issue = makeIssue(7, ["fleet:review"], { body: epicIssue().body });

    await closeFinishedEpics(ctx, project, [issue], new Set());

    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  it("ignores a plan epic that isn't in fleet:review yet", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    const issue = epicIssue({ labels: ["fleet:in-progress", "fleet:plan"] });

    await closeFinishedEpics(ctx, project, [issue], new Set());

    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  it("ignores a plan epic with no Children task list yet (no children filed)", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    const issue = epicIssue({ body: "epic body, no children section" });

    await closeFinishedEpics(ctx, project, [issue], new Set());

    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  it("still logs and continues when closing the issue fails", async () => {
    vi.mocked(github.closeIssue).mockRejectedValue(new Error("gh: rate limited"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });

    await expect(closeFinishedEpics(ctx, project, [epicIssue()], new Set())).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
