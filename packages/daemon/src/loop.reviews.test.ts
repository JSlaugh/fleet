import type { TicketRecord } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { pickReviewCandidates, shouldActOnFeedback } from "./loop.ts";

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
