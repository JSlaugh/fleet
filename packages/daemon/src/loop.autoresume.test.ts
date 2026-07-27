import type { TicketRecord, TicketStatus } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { pickAutoResumable } from "./recovery.ts";

function record(issueNumber: number, patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    branch: `fleet/${issueNumber}`,
    worktreePath: `/tmp/wt/${issueNumber}`,
    sessionId: `sess-${issueNumber}`,
    status: "stalled" as TicketStatus,
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 1,
    ...patch,
  };
}

const project = { name: "alpha", maxConcurrent: 2 };

describe("pickAutoResumable", () => {
  it("picks stalled tickets that have a session", () => {
    const picked = pickAutoResumable([record(1)], project, []);
    expect(picked.map((r) => r.issueNumber)).toEqual([1]);
  });

  it("skips tickets that are not stalled", () => {
    const records = [record(1, { status: "running" }), record(2, { status: "review" }), record(3, { status: "needs-input" })];
    expect(pickAutoResumable(records, project, [])).toEqual([]);
  });

  it("skips tickets with no session to resume", () => {
    expect(pickAutoResumable([record(1, { sessionId: undefined })], project, [])).toEqual([]);
  });

  it("skips tickets already auto-resumed once", () => {
    expect(pickAutoResumable([record(1, { autoResumed: true })], project, [])).toEqual([]);
  });

  it("skips tickets already in flight", () => {
    expect(pickAutoResumable([record(1)], project, ["alpha#1"])).toEqual([]);
  });

  it("ignores records from other projects", () => {
    expect(pickAutoResumable([record(1, { project: "beta" })], project, [])).toEqual([]);
  });

  it("caps at remaining capacity, counting running tickets of the same project", () => {
    const records = [record(1), record(2), record(3)];
    expect(pickAutoResumable(records, project, ["alpha#9"]).map((r) => r.issueNumber)).toEqual([1]);
    expect(pickAutoResumable(records, project, []).map((r) => r.issueNumber)).toEqual([1, 2]);
  });

  it("does not count another project's running tickets against capacity", () => {
    const records = [record(1), record(2)];
    expect(pickAutoResumable(records, { name: "alpha", maxConcurrent: 1 }, ["beta#7"]).map((r) => r.issueNumber)).toEqual([1]);
  });

  it("returns nothing when the project is at capacity", () => {
    expect(pickAutoResumable([record(1)], { name: "alpha", maxConcurrent: 1 }, ["alpha#9"])).toEqual([]);
  });
});
