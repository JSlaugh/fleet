import { describe, expect, it } from "vitest";
import { issueNumberFromUrl, priorityRank } from "./github.ts";

describe("priorityRank", () => {
  it("ranks p1 above p2 above p3", () => {
    expect(priorityRank(["fleet:p1"])).toBeLessThan(priorityRank(["fleet:p2"]));
    expect(priorityRank(["fleet:p2"])).toBeLessThan(priorityRank(["fleet:p3"]));
  });

  it("returns the lowest rank (largest number) when no priority label is present", () => {
    expect(priorityRank(["fleet:ready"])).toBe(3);
    expect(priorityRank([])).toBe(3);
  });

  it("uses the highest priority when several are present", () => {
    expect(priorityRank(["fleet:p3", "fleet:p1"])).toBe(0);
  });
});

describe("issueNumberFromUrl", () => {
  it("takes the number from the last path segment", () => {
    expect(issueNumberFromUrl("https://github.com/JSlaugh/fleet/issues/42")).toBe(42);
  });

  it("tolerates surrounding whitespace", () => {
    expect(issueNumberFromUrl("  https://github.com/JSlaugh/fleet/issues/7\n")).toBe(7);
  });

  it("throws when gh printed something unexpected", () => {
    expect(() => issueNumberFromUrl("")).toThrow();
    expect(() => issueNumberFromUrl("Creating issue in JSlaugh/fleet")).toThrow();
  });
});
