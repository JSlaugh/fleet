import { describe, expect, it } from "vitest";
import type { MachineReviewResult } from "@fleet/shared";
import {
  MACHINE_REVIEW_OUTPUT_SCHEMA,
  buildMachineReviewFixPrompt,
  buildMachineReviewPrompt,
  isActionable,
  selectReviewModel,
  shouldMachineReview,
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
