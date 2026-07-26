import { describe, expect, it } from "vitest";
import { selectEligibleReady } from "./loop.ts";
import type { ReadyIssue } from "./github.ts";

function issue(number: number, patch: Partial<ReadyIssue> = {}): ReadyIssue {
  return {
    number,
    title: `issue ${number}`,
    body: "",
    labels: ["fleet:ready"],
    ...patch,
  };
}

const notRunning = () => false;

describe("selectEligibleReady", () => {
  it("selects ready issues with no dependencies", () => {
    const picked = selectEligibleReady([issue(1)], {
      openIssueNumbers: new Set(),
      allIssueNumbers: new Set(),
      isRunning: notRunning,
    });
    expect(picked.map((i) => i.number)).toEqual([1]);
  });

  it("excludes issues that aren't labeled fleet:ready", () => {
    const picked = selectEligibleReady([issue(1, { labels: ["fleet:in-progress"] })], {
      openIssueNumbers: new Set(),
      allIssueNumbers: new Set(),
      isRunning: notRunning,
    });
    expect(picked).toEqual([]);
  });

  it("excludes issues already in flight", () => {
    const picked = selectEligibleReady([issue(1)], {
      openIssueNumbers: new Set(),
      allIssueNumbers: new Set(),
      isRunning: (n) => n === 1,
    });
    expect(picked).toEqual([]);
  });

  it("excludes a ready issue with an open dependency", () => {
    const picked = selectEligibleReady([issue(2, { body: "Depends-on: #1" })], {
      openIssueNumbers: new Set([1]),
      allIssueNumbers: new Set([1]),
      isRunning: notRunning,
    });
    expect(picked).toEqual([]);
  });

  it("includes a ready issue once its dependency is closed", () => {
    const picked = selectEligibleReady([issue(2, { body: "Depends-on: #1" })], {
      openIssueNumbers: new Set(),
      allIssueNumbers: new Set([1]),
      isRunning: notRunning,
    });
    expect(picked.map((i) => i.number)).toEqual([2]);
  });

  it("includes a ready issue whose dependency doesn't exist", () => {
    const picked = selectEligibleReady([issue(2, { body: "Depends-on: #999" })], {
      openIssueNumbers: new Set(),
      allIssueNumbers: new Set(),
      isRunning: notRunning,
    });
    expect(picked.map((i) => i.number)).toEqual([2]);
  });

  it("requires every dependency in a chain to be satisfied", () => {
    const picked = selectEligibleReady([issue(3, { body: "Depends-on: #1, #2" })], {
      openIssueNumbers: new Set([2]),
      allIssueNumbers: new Set([1, 2]),
      isRunning: notRunning,
    });
    expect(picked).toEqual([]);
  });

  it("leaves independent ready issues unaffected by another chain", () => {
    const picked = selectEligibleReady(
      [issue(1), issue(2, { body: "Depends-on: #1" })],
      { openIssueNumbers: new Set([1]), allIssueNumbers: new Set([1]), isRunning: notRunning },
    );
    expect(picked.map((i) => i.number)).toEqual([1]);
  });

  it("preserves input order", () => {
    const picked = selectEligibleReady([issue(5), issue(2), issue(9)], {
      openIssueNumbers: new Set(),
      allIssueNumbers: new Set(),
      isRunning: notRunning,
    });
    expect(picked.map((i) => i.number)).toEqual([5, 2, 9]);
  });
});
