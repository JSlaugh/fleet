import { describe, expect, it } from "vitest";
import {
  PlanResultSchema,
  boardStatusFromLabels,
  mergeModelUsage,
  parseWorkerQuestions,
  priorityOf,
  shortModelName,
} from "./index.ts";

describe("boardStatusFromLabels", () => {
  it("maps each fleet label to its board status", () => {
    expect(boardStatusFromLabels(["fleet:ready"])).toBe("ready");
    expect(boardStatusFromLabels(["fleet:in-progress"])).toBe("in-progress");
    expect(boardStatusFromLabels(["fleet:needs-input"])).toBe("needs-input");
    expect(boardStatusFromLabels(["fleet:review"])).toBe("review");
  });

  it("returns null when no board label is present", () => {
    expect(boardStatusFromLabels(["fleet:p1", "bug"])).toBeNull();
  });

  it("prefers ready when multiple board labels are present", () => {
    expect(boardStatusFromLabels(["fleet:review", "fleet:ready"])).toBe("ready");
  });
});

describe("priorityOf", () => {
  it("returns the matching priority label", () => {
    expect(priorityOf(["fleet:p2"])).toBe("fleet:p2");
  });

  it("returns the highest priority when several are present", () => {
    expect(priorityOf(["fleet:p3", "fleet:p1"])).toBe("fleet:p1");
  });

  it("returns null with no priority label", () => {
    expect(priorityOf(["fleet:ready"])).toBeNull();
  });
});

describe("shortModelName", () => {
  it("strips the claude- prefix and date suffix", () => {
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });

  it("leaves a name without prefix/suffix mostly intact", () => {
    expect(shortModelName("opus-4-8")).toBe("opus-4-8");
  });

  it("returns an empty string for undefined", () => {
    expect(shortModelName(undefined)).toBe("");
  });
});

describe("mergeModelUsage", () => {
  const opus = { inputTokens: 100, outputTokens: 10, costUsd: 0.5 };
  const haiku = { inputTokens: 20, outputTokens: 5, costUsd: 0.01 };

  it("returns undefined when both sides are undefined", () => {
    expect(mergeModelUsage(undefined, undefined)).toBeUndefined();
  });

  it("returns a copy of whichever side is present", () => {
    expect(mergeModelUsage(undefined, { opus })).toEqual({ opus });
    expect(mergeModelUsage({ opus }, undefined)).toEqual({ opus });
  });

  it("sums overlapping keys field by field", () => {
    expect(mergeModelUsage({ opus }, { opus })).toEqual({
      opus: { inputTokens: 200, outputTokens: 20, costUsd: 1 },
    });
  });

  it("unions disjoint keys", () => {
    expect(mergeModelUsage({ opus }, { haiku })).toEqual({ opus, haiku });
  });

  it("does not mutate either input", () => {
    const base = { opus: { ...opus } };
    const delta = { opus: { ...opus }, haiku: { ...haiku } };
    mergeModelUsage(base, delta);
    expect(base).toEqual({ opus });
    expect(delta).toEqual({ opus, haiku });
  });
});

describe("parseWorkerQuestions", () => {
  it("returns [] for a non-object input", () => {
    expect(parseWorkerQuestions("nope")).toEqual([]);
    expect(parseWorkerQuestions(null)).toEqual([]);
    expect(parseWorkerQuestions(42)).toEqual([]);
  });

  it("returns [] when questions is missing or not an array", () => {
    expect(parseWorkerQuestions({})).toEqual([]);
    expect(parseWorkerQuestions({ questions: "x" })).toEqual([]);
  });

  it("keeps valid entries and filters out invalid ones", () => {
    const parsed = parseWorkerQuestions({
      questions: [
        { question: "Which DB?", header: "DB", options: [{ label: "pg" }] },
        { header: "no question field" }, // invalid — dropped
        "not an object", // invalid — dropped
        { question: "Deploy now?" },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed.map((q) => q.question)).toEqual(["Which DB?", "Deploy now?"]);
  });
});

describe("PlanResultSchema", () => {
  it("parses a completed plan with tickets", () => {
    const parsed = PlanResultSchema.safeParse({
      status: "completed",
      summary: "Split the epic into three tickets.",
      tickets: [
        { title: "Add X", body: "Problem, acceptance criteria, verification." },
        { title: "Add Y", body: "Problem, acceptance criteria, verification.", priority: "fleet:p2" },
      ],
      confidence: "high",
    });
    expect(parsed.success).toBe(true);
  });

  it("parses a blocked plan with no tickets", () => {
    const parsed = PlanResultSchema.safeParse({
      status: "blocked",
      summary: "Epic is too vague to decompose.",
      tickets: [],
      blockedReason: "Which subsystem should this target?",
      confidence: "low",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown priority label", () => {
    const parsed = PlanResultSchema.safeParse({
      status: "completed",
      summary: "s",
      tickets: [{ title: "t", body: "b", priority: "fleet:urgent" }],
      confidence: "high",
    });
    expect(parsed.success).toBe(false);
  });

  it("parses tickets with a tier and defaults tier to undefined", () => {
    const parsed = PlanResultSchema.safeParse({
      status: "completed",
      summary: "s",
      tickets: [
        { title: "light one", body: "b", tier: "light" },
        { title: "elevated one", body: "b", tier: "elevated" },
        { title: "no tier", body: "b" },
      ],
      confidence: "high",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tickets.map((t) => t.tier)).toEqual(["light", "elevated", undefined]);
    }
  });

  it("rejects an unknown tier", () => {
    const parsed = PlanResultSchema.safeParse({
      status: "completed",
      summary: "s",
      tickets: [{ title: "t", body: "b", tier: "urgent" }],
      confidence: "high",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires status, summary, tickets, and confidence", () => {
    expect(PlanResultSchema.safeParse({}).success).toBe(false);
    expect(
      PlanResultSchema.safeParse({ status: "completed", summary: "s", confidence: "high" }).success,
    ).toBe(false);
  });
});
