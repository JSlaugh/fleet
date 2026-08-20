import { describe, expect, it } from "vitest";
import type { MachineReviewResult, PlanResult, PlanReviewResult } from "@fleet/shared";
import {
  MACHINE_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  buildMachineReviewFixPrompt,
  buildMachineReviewPrompt,
  buildPlanReviewFixPrompt,
  buildPlanReviewPrompt,
  isActionable,
  isPlanActionable,
  selectReviewModel,
  shouldMachineReview,
  shouldReviewPlan,
  truncateDiff,
} from "./review.ts";

describe("shouldMachineReview", () => {
  it("reviews by default", () => {
    expect(shouldMachineReview({}, undefined)).toBe(true);
    expect(shouldMachineReview({ machineReview: true }, { })).toBe(true);
  });

  it("skips when the project opts out", () => {
    expect(shouldMachineReview({ machineReview: false }, undefined)).toBe(false);
  });

  it("skips plan tickets", () => {
    expect(shouldMachineReview({}, { isPlan: true })).toBe(false);
  });

  it("caps at one attempt per ticket — any recorded outcome skips, including pending and skipped", () => {
    for (const machineReviewOutcome of ["pending", "passed", "findings", "skipped"]) {
      expect(shouldMachineReview({}, { machineReviewOutcome })).toBe(false);
    }
  });
});

describe("shouldReviewPlan", () => {
  it("reviews by default", () => {
    expect(shouldReviewPlan({}, undefined)).toBe(true);
    expect(shouldReviewPlan({ machineReview: true }, {})).toBe(true);
  });

  it("skips when the project opts out — same switch as shouldMachineReview", () => {
    expect(shouldReviewPlan({ machineReview: false }, undefined)).toBe(false);
  });

  it("caps at one attempt per ticket — any recorded outcome skips, including pending and skipped", () => {
    for (const machineReviewOutcome of ["pending", "passed", "findings", "skipped"]) {
      expect(shouldReviewPlan({}, { machineReviewOutcome })).toBe(false);
    }
  });
});

describe("selectReviewModel", () => {
  it("prefers lightModel", () => {
    expect(selectReviewModel({ model: "claude-sonnet-5", lightModel: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
  });

  it("falls back to the project model", () => {
    expect(selectReviewModel({ model: "claude-sonnet-5" })).toBe("claude-sonnet-5");
  });

  it("is undefined when neither is configured (CLI default)", () => {
    expect(selectReviewModel({})).toBeUndefined();
  });
});

describe("truncateDiff", () => {
  it("passes short diffs through untouched", () => {
    expect(truncateDiff("short", 100)).toBe("short");
  });

  it("truncates long diffs with a marker", () => {
    const out = truncateDiff("x".repeat(150), 100);
    expect(out.startsWith("x".repeat(100))).toBe(true);
    expect(out).toContain("truncated at 100 characters");
  });
});

describe("isActionable", () => {
  const finding = { file: "a.ts", summary: "bug", detail: "why" };

  it("is actionable only for a findings verdict with findings", () => {
    expect(isActionable({ verdict: "findings", summary: "s", findings: [finding] })).toBe(true);
  });

  it("treats a findings verdict with an empty list as a pass", () => {
    expect(isActionable({ verdict: "findings", summary: "s", findings: [] })).toBe(false);
  });

  it("never actionable on pass", () => {
    expect(isActionable({ verdict: "pass", summary: "s", findings: [finding] })).toBe(false);
  });
});

describe("prompts", () => {
  it("buildMachineReviewPrompt carries issue, commits, and fenced diff", () => {
    const prompt = buildMachineReviewPrompt({ number: 7, title: "Fix the thing", body: "Details" }, "abc123 fix", "diff --git a b", "main");
    expect(prompt).toContain("issue #7: Fix the thing");
    expect(prompt).toContain("abc123 fix");
    expect(prompt).toContain("```diff\ndiff --git a b\n```");
    expect(prompt).toContain("origin/main");
  });

  it("buildMachineReviewPrompt omits the checklist section for untyped tickets", () => {
    const prompt = buildMachineReviewPrompt({ number: 7, title: "Fix the thing", body: "Details" }, "abc123 fix", "diff --git a b", "main");
    expect(prompt).not.toContain("Additional review dimensions");
  });

  it("buildMachineReviewPrompt appends the type's checklist as explicit review dimensions when given one", () => {
    const prompt = buildMachineReviewPrompt(
      { number: 7, title: "Fix the thing", body: "Details" },
      "abc123 fix",
      "diff --git a b",
      "main",
      "- Accessibility: keyboard-reachable controls\n- Dark mode: uses theme tokens",
    );
    expect(prompt).toContain("## Additional review dimensions for this ticket's type");
    expect(prompt).toContain("Accessibility: keyboard-reachable controls");
    expect(prompt).toContain("Dark mode: uses theme tokens");
  });

  it("buildMachineReviewPrompt omits the verify section for untyped tickets or types with no verify commands", () => {
    const prompt = buildMachineReviewPrompt({ number: 7, title: "Fix the thing", body: "Details" }, "abc123 fix", "diff --git a b", "main", undefined, []);
    expect(prompt).not.toContain("Required verification");
  });

  it("buildMachineReviewPrompt tells the read-only reviewer to check for evidence the type's verify commands ran", () => {
    const prompt = buildMachineReviewPrompt(
      { number: 7, title: "Fix the thing", body: "Details" },
      "abc123 fix",
      "diff --git a b",
      "main",
      undefined,
      ["pnpm --filter @fleet/daemon typecheck", "pnpm --filter @fleet/daemon test"],
    );
    expect(prompt).toContain("## Required verification for this ticket type");
    expect(prompt).toContain("- `pnpm --filter @fleet/daemon typecheck`");
    expect(prompt).toContain("- `pnpm --filter @fleet/daemon test`");
    expect(prompt).toContain("You cannot run them yourself");
  });

  it("buildMachineReviewFixPrompt names each finding with location, severity, and detail, and allows rebuttal", () => {
    const result: MachineReviewResult = {
      verdict: "findings",
      summary: "Two problems.",
      findings: [
        { file: "src/a.ts", line: 12, severity: "major", summary: "off-by-one", detail: "loop bound excludes the last item" },
        { file: "src/b.ts", summary: "missing null check", detail: "crashes on empty input" },
      ],
    };
    const prompt = buildMachineReviewFixPrompt(result);
    expect(prompt).toContain("**src/a.ts:12** (major): off-by-one");
    expect(prompt).toContain("loop bound excludes the last item");
    expect(prompt).toContain("**src/b.ts**: missing null check");
    expect(prompt).toContain("explain in your final summary why one is not a real issue");
  });
});

describe("MACHINE_REVIEW_OUTPUT_SCHEMA", () => {
  it("is a top-level object schema (the API rejects top-level oneOf/allOf/anyOf)", () => {
    expect(MACHINE_REVIEW_OUTPUT_SCHEMA.type).toBe("object");
    expect(MACHINE_REVIEW_OUTPUT_SCHEMA.oneOf).toBeUndefined();
    expect(MACHINE_REVIEW_OUTPUT_SCHEMA.allOf).toBeUndefined();
    expect(MACHINE_REVIEW_OUTPUT_SCHEMA.anyOf).toBeUndefined();
  });
});

describe("PLAN_REVIEW_OUTPUT_SCHEMA", () => {
  it("is a top-level object schema (the API rejects top-level oneOf/allOf/anyOf)", () => {
    expect(PLAN_REVIEW_OUTPUT_SCHEMA.type).toBe("object");
    expect(PLAN_REVIEW_OUTPUT_SCHEMA.oneOf).toBeUndefined();
    expect(PLAN_REVIEW_OUTPUT_SCHEMA.allOf).toBeUndefined();
    expect(PLAN_REVIEW_OUTPUT_SCHEMA.anyOf).toBeUndefined();
  });
});

describe("isPlanActionable", () => {
  const finding = { summary: "bug", detail: "why" };

  it("is actionable only for a findings verdict with findings", () => {
    expect(isPlanActionable({ verdict: "findings", summary: "s", findings: [finding] })).toBe(true);
  });

  it("treats a findings verdict with an empty list as a pass", () => {
    expect(isPlanActionable({ verdict: "findings", summary: "s", findings: [] })).toBe(false);
  });

  it("never actionable on pass", () => {
    expect(isPlanActionable({ verdict: "pass", summary: "s", findings: [finding] })).toBe(false);
  });
});

describe("plan review prompts", () => {
  const planResult: PlanResult = {
    status: "completed",
    summary: "Splits the epic into two tickets.",
    confidence: "high",
    tickets: [
      { title: "Add the schema field", body: "## Problem\n\nAdd a field", tier: "light", dependsOnIndex: [] },
      { title: "Use it in the dashboard", body: "## Problem\n\nUse the field", dependsOnIndex: [0] },
    ],
  };

  it("buildPlanReviewPrompt carries the epic, planner summary, and each indexed child ticket", () => {
    const prompt = buildPlanReviewPrompt({ number: 12, title: "Epic: field rollout", body: "Roll out the field" }, planResult);
    expect(prompt).toContain("epic #12: Epic: field rollout");
    expect(prompt).toContain("Splits the epic into two tickets.");
    expect(prompt).toContain("[0] Add the schema field");
    expect(prompt).toContain("[1] Use it in the dashboard");
    expect(prompt).toContain("Depends on: 0");
  });

  it("buildPlanReviewFixPrompt names each finding by ticket index or the decomposition as a whole", () => {
    const result: PlanReviewResult = {
      verdict: "findings",
      summary: "Two problems.",
      findings: [
        { ticketIndex: 1, severity: "major", summary: "not self-contained", detail: "references ticket 0's schema without restating it" },
        { summary: "missing scope", detail: "no ticket covers the migration script" },
      ],
    };
    const prompt = buildPlanReviewFixPrompt(result);
    expect(prompt).toContain("**child ticket [1]** (major): not self-contained");
    expect(prompt).toContain("references ticket 0's schema without restating it");
    expect(prompt).toContain("**the decomposition as a whole**: missing scope");
    expect(prompt).toContain("Revise tickets[]");
  });
});
