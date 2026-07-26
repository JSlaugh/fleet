import type { ProjectConfig } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { dependencyStatus, issueNumberFromUrl, parseDependsOn, priorityRank, readyLabelArgs } from "./github.ts";

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

describe("readyLabelArgs", () => {
  const project = {
    name: "alpha",
    repoPath: "/repo/alpha",
    githubRepo: "acme/alpha",
    defaultBranch: "main",
    maxConcurrent: 1,
  } satisfies ProjectConfig;

  it("removes every other fleet state label and adds fleet:ready", () => {
    expect(readyLabelArgs(project, 7)).toEqual([
      "issue", "edit", "7",
      "--repo", "acme/alpha",
      "--remove-label", "fleet:in-progress",
      "--remove-label", "fleet:needs-input",
      "--remove-label", "fleet:review",
      "--add-label", "fleet:ready",
    ]);
  });

  it("never removes fleet:ready itself", () => {
    expect(readyLabelArgs(project, 7).filter((a) => a === "fleet:ready")).toEqual(["fleet:ready"]);
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

describe("parseDependsOn", () => {
  it("returns [] when there is no Depends-on line", () => {
    expect(parseDependsOn("Just a plain description.")).toEqual([]);
  });

  it("parses a single dependency", () => {
    expect(parseDependsOn("Depends-on: #12")).toEqual([12]);
  });

  it("parses multiple comma-separated dependencies", () => {
    expect(parseDependsOn("Depends-on: #12, #14")).toEqual([12, 14]);
  });

  it("accepts mixed comma and space separators", () => {
    expect(parseDependsOn("Depends-on: #12 #14, #16")).toEqual([12, 14, 16]);
  });

  it("ignores malformed entries but keeps the valid ones", () => {
    expect(parseDependsOn("Depends-on: #12, banana, 14, #16")).toEqual([12, 16]);
  });

  it("is case-insensitive on the key", () => {
    expect(parseDependsOn("depends-on: #5")).toEqual([5]);
    expect(parseDependsOn("DEPENDS-ON: #5")).toEqual([5]);
  });

  it("finds the line anywhere in a multi-line body", () => {
    const body = ["## Problem", "Some description.", "", "Depends-on: #3", "", "## More"].join("\n");
    expect(parseDependsOn(body)).toEqual([3]);
  });

  it("dedupes repeated references", () => {
    expect(parseDependsOn("Depends-on: #4, #4")).toEqual([4]);
  });
});

describe("dependencyStatus", () => {
  it("reports no dependency as blocking or unknown when there are none", () => {
    expect(dependencyStatus([], new Set(), new Set())).toEqual({ blockedBy: [], unknown: [] });
  });

  it("treats an open dependency as blocking", () => {
    expect(dependencyStatus([12], new Set([12]), new Set([12]))).toEqual({ blockedBy: [12], unknown: [] });
  });

  it("treats a closed dependency as satisfied", () => {
    expect(dependencyStatus([12], new Set(), new Set([12]))).toEqual({ blockedBy: [], unknown: [] });
  });

  it("treats a nonexistent dependency as satisfied but flags it as unknown", () => {
    expect(dependencyStatus([999], new Set(), new Set())).toEqual({ blockedBy: [], unknown: [999] });
  });

  it("handles a mix of blocking, satisfied, and unknown deps", () => {
    expect(dependencyStatus([1, 2, 999], new Set([1]), new Set([1, 2]))).toEqual({
      blockedBy: [1],
      unknown: [999],
    });
  });
});
