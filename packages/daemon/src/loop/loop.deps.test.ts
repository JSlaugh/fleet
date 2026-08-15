import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRecord } from "../test-support.ts";
import { selectEligibleReady } from "./claim.ts";
import type { ReadyIssue } from "../github/github.ts";

function issue(number: number, patch: Partial<ReadyIssue> = {}): ReadyIssue {
  return {
    number,
    title: `issue ${number}`,
    body: "",
    labels: ["fleet:ready"],
    author: "collab-author",
    ...patch,
  };
}

const notRunning = () => false;
const noRecord = () => undefined;

/** Default opts shared by every case below; individual tests override just what they're exercising. */
function opts(patch: Partial<Parameters<typeof selectEligibleReady>[1]> = {}) {
  return {
    openIssueNumbers: new Set<number>(),
    allIssueNumbers: new Set<number>(),
    isRunning: notRunning,
    getRecord: noRecord,
    projectName: "alpha",
    ...patch,
  };
}

describe("selectEligibleReady", () => {
  it("selects ready issues with no dependencies", () => {
    const picked = selectEligibleReady([issue(1)], opts());
    expect(picked.map((i) => i.number)).toEqual([1]);
  });

  it("excludes issues that aren't labeled fleet:ready", () => {
    const picked = selectEligibleReady([issue(1, { labels: ["fleet:in-progress"] })], opts());
    expect(picked).toEqual([]);
  });

  it("excludes issues already in flight", () => {
    const picked = selectEligibleReady([issue(1)], opts({ isRunning: (n) => n === 1 }));
    expect(picked).toEqual([]);
  });

  it("excludes a ready issue with an open dependency", () => {
    const picked = selectEligibleReady(
      [issue(2, { body: "Depends-on: #1" })],
      opts({ openIssueNumbers: new Set([1]), allIssueNumbers: new Set([1]) }),
    );
    expect(picked).toEqual([]);
  });

  it("includes a ready issue once its dependency is closed", () => {
    const picked = selectEligibleReady(
      [issue(2, { body: "Depends-on: #1" })],
      opts({ allIssueNumbers: new Set([1]) }),
    );
    expect(picked.map((i) => i.number)).toEqual([2]);
  });

  it("includes a ready issue whose dependency doesn't exist", () => {
    const picked = selectEligibleReady([issue(2, { body: "Depends-on: #999" })], opts());
    expect(picked.map((i) => i.number)).toEqual([2]);
  });

  it("requires every dependency in a chain to be satisfied", () => {
    const picked = selectEligibleReady(
      [issue(3, { body: "Depends-on: #1, #2" })],
      opts({ openIssueNumbers: new Set([2]), allIssueNumbers: new Set([1, 2]) }),
    );
    expect(picked).toEqual([]);
  });

  it("leaves independent ready issues unaffected by another chain", () => {
    const picked = selectEligibleReady(
      [issue(1), issue(2, { body: "Depends-on: #1" })],
      opts({ openIssueNumbers: new Set([1]), allIssueNumbers: new Set([1]) }),
    );
    expect(picked.map((i) => i.number)).toEqual([1]);
  });

  it("preserves input order", () => {
    const picked = selectEligibleReady([issue(5), issue(2), issue(9)], opts());
    expect(picked.map((i) => i.number)).toEqual([5, 2, 9]);
  });

  describe("label consistency guard", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it.each([["fleet:in-progress"], ["fleet:review"], ["fleet:needs-input"]])(
      "excludes a ready issue that also carries %s, and logs the conflict",
      (statusLabel) => {
        const picked = selectEligibleReady([issue(62, { labels: ["fleet:ready", statusLabel] })], opts());
        expect(picked).toEqual([]);
        const lines = logSpy.mock.calls.map((call) => String(call[0]));
        expect(lines.some((l) => l.includes("alpha#62") && l.includes(statusLabel))).toBe(true);
      },
    );

    it("does not treat tier/priority labels as a conflict", () => {
      const picked = selectEligibleReady(
        [issue(1, { labels: ["fleet:ready", "fleet:elevate", "fleet:p1"] })],
        opts(),
      );
      expect(picked.map((i) => i.number)).toEqual([1]);
    });
  });

  describe("state record guard", () => {
    it("excludes a cleanly-labeled ready issue whose record already shows review", () => {
      const picked = selectEligibleReady(
        [issue(62)],
        opts({ getRecord: () => makeRecord({ status: "review", prUrl: "https://github.com/acme/alpha/pull/72" }) }),
      );
      expect(picked).toEqual([]);
    });

    it("excludes a cleanly-labeled ready issue whose record already shows needs-input", () => {
      const picked = selectEligibleReady(
        [issue(62)],
        opts({ getRecord: () => makeRecord({ status: "needs-input" }) }),
      );
      expect(picked).toEqual([]);
    });

    it("excludes a ready issue whose record carries a prUrl even if status looks earlier", () => {
      const picked = selectEligibleReady(
        [issue(62)],
        opts({ getRecord: () => makeRecord({ status: "running", prUrl: "https://github.com/acme/alpha/pull/72" }) }),
      );
      expect(picked).toEqual([]);
    });

    it("does not exclude a stalled record — stall recovery must stay separate from new claims", () => {
      const picked = selectEligibleReady(
        [issue(62)],
        opts({ getRecord: () => makeRecord({ status: "stalled" }) }),
      );
      expect(picked.map((i) => i.number)).toEqual([62]);
    });

    it("claims normally once auto-escalation moves an issue back to ready+elevate after a failed run", () => {
      const picked = selectEligibleReady(
        [issue(62, { labels: ["fleet:ready", "fleet:elevate"] })],
        opts({ getRecord: () => makeRecord({ status: "failed", autoElevated: true }) }),
      );
      expect(picked.map((i) => i.number)).toEqual([62]);
    });

    it("claims normally once an operator restarts a ticket that had reached fleet:review (resetForFreshClaim clears prUrl)", () => {
      // Mirrors what `resetForFreshClaim` (operator.ts) leaves behind: status
      // "restarting", prUrl cleared. Without that clear this would deadlock —
      // see the record guard's prUrl check above.
      const picked = selectEligibleReady(
        [issue(62)],
        opts({ getRecord: () => makeRecord({ status: "restarting", prUrl: undefined }) }),
      );
      expect(picked.map((i) => i.number)).toEqual([62]);
    });
  });
});
