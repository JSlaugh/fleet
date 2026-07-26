import { describe, expect, it } from "vitest";
import {
  boardStatusFromLabels,
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
