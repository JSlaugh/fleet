import type { TicketRecord } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { pickReviewCandidates, shouldActOnFeedback, shouldClearConflictGuard, shouldResumeForConflict } from "./reviews.ts";

function record(issueNumber: number, patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    branch: `fleet/${issueNumber}`,
    worktreePath: `/tmp/wt/${issueNumber}`,
    sessionId: `sess-${issueNumber}`,
    status: "review",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 1,
    prUrl: `https://github.com/acme/alpha/pull/${issueNumber}`,
    ...patch,
  };
}

const project = { name: "alpha" };
const open = new Set([1, 2, 3]);

describe("pickReviewCandidates", () => {
  it("picks review tickets with a PR and a session", () => {
    expect(pickReviewCandidates([record(1)], project, open, []).map((r) => r.issueNumber)).toEqual([1]);
  });

  it("skips tickets not in review", () => {
    const records = [record(1, { status: "running" }), record(2, { status: "needs-input" })];
    expect(pickReviewCandidates(records, project, open, [])).toEqual([]);
  });

  it("skips tickets with no PR url", () => {
    expect(pickReviewCandidates([record(1, { prUrl: undefined })], project, open, [])).toEqual([]);
  });

  it("skips tickets with no session to resume", () => {
    expect(pickReviewCandidates([record(1, { sessionId: undefined })], project, open, [])).toEqual([]);
  });

  it("skips tickets whose issue is no longer open", () => {
    expect(pickReviewCandidates([record(4)], project, open, [])).toEqual([]);
  });

  it("skips tickets already in flight", () => {
    expect(pickReviewCandidates([record(1)], project, open, ["alpha#1"])).toEqual([]);
  });

  it("ignores records from other projects", () => {
    expect(pickReviewCandidates([record(1, { project: "beta" })], project, open, [])).toEqual([]);
  });

  it("returns nothing when the project opts out", () => {
    expect(pickReviewCandidates([record(1)], { name: "alpha", autoAddressReviews: false }, open, [])).toEqual([]);
  });
});

describe("shouldActOnFeedback", () => {
  it("acts on a changes-requested review even with no comments", () => {
    expect(shouldActOnFeedback({ hasChangesRequested: true, reviews: [], comments: [] })).toBe(true);
  });

  it("acts when there are review bodies", () => {
    expect(shouldActOnFeedback({ hasChangesRequested: false, reviews: [{ author: "a", state: "COMMENTED", body: "x", submittedAt: "t" }], comments: [] })).toBe(true);
  });

  it("acts when there are inline comments", () => {
    expect(shouldActOnFeedback({ hasChangesRequested: false, reviews: [], comments: [{ path: "a.ts", line: 1, body: "x", author: "a", createdAt: "t" }] })).toBe(true);
  });

  it("does nothing for an approved review with no comments", () => {
    expect(shouldActOnFeedback({ hasChangesRequested: false, reviews: [], comments: [] })).toBe(false);
  });
});

describe("shouldResumeForConflict", () => {
  it("resumes on a fresh CONFLICTING state", () => {
    expect(shouldResumeForConflict("CONFLICTING", undefined)).toBe(true);
  });

  it("does not resume a CONFLICTING state already handled", () => {
    expect(shouldResumeForConflict("CONFLICTING", true)).toBe(false);
  });

  it("never resumes on UNKNOWN", () => {
    expect(shouldResumeForConflict("UNKNOWN", undefined)).toBe(false);
    expect(shouldResumeForConflict("UNKNOWN", true)).toBe(false);
  });

  it("never resumes on MERGEABLE", () => {
    expect(shouldResumeForConflict("MERGEABLE", undefined)).toBe(false);
  });
});

describe("shouldClearConflictGuard", () => {
  it("clears a previously-handled conflict once the PR is MERGEABLE again", () => {
    expect(shouldClearConflictGuard("MERGEABLE", true)).toBe(true);
  });

  it("does nothing when there was nothing to clear", () => {
    expect(shouldClearConflictGuard("MERGEABLE", undefined)).toBe(false);
    expect(shouldClearConflictGuard("MERGEABLE", false)).toBe(false);
  });

  it("does not clear on CONFLICTING or UNKNOWN", () => {
    expect(shouldClearConflictGuard("CONFLICTING", true)).toBe(false);
    expect(shouldClearConflictGuard("UNKNOWN", true)).toBe(false);
  });
});
