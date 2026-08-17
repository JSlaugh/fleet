import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCtx, makeIssue, makeProject } from "../test-support.ts";
import { applyIntakeLint, lintIntakeBody } from "./intake.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  upsertStatusComment: vi.fn(async () => {}),
  swapLabel: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

beforeEach(() => {
  vi.clearAllMocks();
});

const issue = makeIssue;
const project = makeProject({ intakeLint: true });

const FORM_BORN = [
  "### Problem",
  "Widgets don't rotate.",
  "",
  "### Acceptance criteria",
  "- [ ] Widgets rotate",
  "",
  "### Verification",
  "pnpm test",
].join("\n");

const SKILL_SYNONYMS = [
  "## Summary",
  "Widgets don't rotate.",
  "",
  "## Requirements",
  "- [ ] Widgets rotate",
  "",
  "## Test plan",
  "pnpm test",
].join("\n");

const MIXED_LEVELS = ["# Problem", "text", "## Acceptance", "text", "### Verify", "text"].join("\n");

describe("lintIntakeBody", () => {
  it("passes a form-born body with the exact required headings", () => {
    expect(lintIntakeBody(FORM_BORN, { isPlan: false })).toEqual([]);
  });

  it("passes a body using synonym headings", () => {
    expect(lintIntakeBody(SKILL_SYNONYMS, { isPlan: false })).toEqual([]);
  });

  it("passes headings at mixed levels (# / ## / ###)", () => {
    expect(lintIntakeBody(MIXED_LEVELS, { isPlan: false })).toEqual([]);
  });

  it("matches headings case-insensitively", () => {
    const body = ["### PROBLEM", "x", "### Acceptance Criteria", "x", "### verification", "x"].join("\n");
    expect(lintIntakeBody(body, { isPlan: false })).toEqual([]);
  });

  it("reports exactly the missing section when only one is absent", () => {
    const body = ["### Problem", "x", "### Acceptance criteria", "x"].join("\n");
    expect(lintIntakeBody(body, { isPlan: false })).toEqual(["verification"]);
  });

  it("reports all three sections missing from an empty body", () => {
    expect(lintIntakeBody("", { isPlan: false })).toEqual(["problem", "acceptance", "verification"]);
  });

  it("does not treat bold text as a heading", () => {
    const body = "**Problem** — widgets don't rotate.\n\n**Acceptance criteria** — they should.\n\n**Verification** — pnpm test.";
    expect(lintIntakeBody(body, { isPlan: false })).toEqual(["problem", "acceptance", "verification"]);
  });

  it("requires only a problem section for a fleet:plan epic", () => {
    expect(lintIntakeBody("## Context\nDecompose this subsystem.", { isPlan: true })).toEqual([]);
  });

  it("still flags a fleet:plan epic missing even a problem section", () => {
    expect(lintIntakeBody("## Scope boundaries\nOut of scope: X.", { isPlan: true })).toEqual(["problem"]);
  });

  it("passes a planner-filed child ticket body (PlanResultSchema's instructed heading shape)", () => {
    const body = [
      "## Problem",
      "The rename left call sites unconverted.",
      "",
      "## Acceptance criteria",
      "- [ ] All call sites updated",
      "",
      "## Verification",
      "pnpm typecheck && pnpm test",
    ].join("\n");
    expect(lintIntakeBody(body, { isPlan: false })).toEqual([]);
  });

  it("passes an MCP-filed ticket body written per the fleet-backlog skill's heading guidance", () => {
    const body = [
      "## Problem",
      "The flaky test fails under load.",
      "",
      "## Acceptance criteria",
      "- [ ] Test passes 20/20 runs",
      "",
      "## Verification",
      "pnpm test -- --run flaky.test.ts",
    ].join("\n");
    expect(lintIntakeBody(body, { isPlan: false })).toEqual([]);
  });
});

describe("applyIntakeLint", () => {
  it("passes through unchanged when intakeLint is false", async () => {
    const ctx = makeCtx();
    const noSections = issue(1, ["fleet:ready"], { body: "" });

    const picked = await applyIntakeLint(ctx, makeProject({ intakeLint: false }), [noSections]);

    expect(picked).toEqual([noSections]);
    expect(github.upsertStatusComment).not.toHaveBeenCalled();
    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("keeps a well-sectioned issue in the passing list without touching github", async () => {
    const ctx = makeCtx();
    const sectioned = issue(1, ["fleet:ready"], { body: FORM_BORN });

    const picked = await applyIntakeLint(ctx, project, [sectioned]);

    expect(picked).toEqual([sectioned]);
    expect(github.upsertStatusComment).not.toHaveBeenCalled();
    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("drops a failing issue, posts what's missing, and swaps fleet:ready straight to fleet:needs-input", async () => {
    const ctx = makeCtx();
    const missingVerification = issue(1, ["fleet:ready"], { body: "### Problem\nx\n### Acceptance criteria\nx" });

    const picked = await applyIntakeLint(ctx, project, [missingVerification]);

    expect(picked).toEqual([]);
    expect(github.upsertStatusComment).toHaveBeenCalledWith(project, 1, expect.stringContaining("Verification"));
    expect(github.swapLabel).toHaveBeenCalledWith(project, 1, "fleet:ready", "fleet:needs-input");
  });

  it("only requires a problem section for a fleet:plan issue", async () => {
    const ctx = makeCtx();
    const planIssue = issue(1, ["fleet:plan", "fleet:ready"], { body: "## Context\nDecompose this." });

    const picked = await applyIntakeLint(ctx, project, [planIssue]);

    expect(picked).toEqual([planIssue]);
    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("under --dry-run, logs the would-be flag instead of mutating github", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeCtx({ dryRun: true });
    const bare = issue(1, ["fleet:ready"], { body: "" });

    const picked = await applyIntakeLint(ctx, project, [bare]);

    expect(picked).toEqual([]);
    expect(github.upsertStatusComment).not.toHaveBeenCalled();
    expect(github.swapLabel).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("[dry-run] would flag alpha#1"))).toBe(true);
    logSpy.mockRestore();
  });

  it("still swaps the label even when the status comment fails to post", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(github.upsertStatusComment).mockRejectedValueOnce(new Error("gh: rate limited"));
    const ctx = makeCtx();
    const bare = issue(1, ["fleet:ready"], { body: "" });

    const picked = await applyIntakeLint(ctx, project, [bare]);

    expect(picked).toEqual([]);
    expect(github.swapLabel).toHaveBeenCalledWith(project, 1, "fleet:ready", "fleet:needs-input");
    errorSpy.mockRestore();
  });

  it("filters a mixed batch down to only the passing issues, preserving order", async () => {
    const ctx = makeCtx();
    const good1 = issue(1, ["fleet:ready"], { body: FORM_BORN });
    const bad = issue(2, ["fleet:ready"], { body: "" });
    const good2 = issue(3, ["fleet:ready"], { body: SKILL_SYNONYMS });

    const picked = await applyIntakeLint(ctx, project, [good1, bad, good2]);

    expect(picked.map((i) => i.number)).toEqual([1, 3]);
  });
});
