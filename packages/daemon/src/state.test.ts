import type { ClosedTicketRecord, TicketRecord } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { trimHistory } from "./state.ts";

function closed(issueNumber: number, closedAt: string, patch: Partial<ClosedTicketRecord> = {}): ClosedTicketRecord {
  const record: TicketRecord = {
    project: "alpha",
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    branch: `fleet/${issueNumber}`,
    worktreePath: `/tmp/wt/${issueNumber}`,
    status: "review",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 1,
  };
  return { ...record, closedAt, prState: "MERGED", ...patch };
}

describe("trimHistory", () => {
  it("sorts newest first", () => {
    const records = [
      closed(1, "2026-01-01T00:00:00.000Z"),
      closed(2, "2026-01-03T00:00:00.000Z"),
      closed(3, "2026-01-02T00:00:00.000Z"),
    ];
    expect(trimHistory(records).map((r) => r.issueNumber)).toEqual([2, 3, 1]);
  });

  it("caps at the given max", () => {
    const records = Array.from({ length: 10 }, (_, i) => closed(i, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`));
    const trimmed = trimHistory(records, 3);
    expect(trimmed).toHaveLength(3);
    expect(trimmed.map((r) => r.issueNumber)).toEqual([9, 8, 7]);
  });

  it("defaults to keeping the most recent 50", () => {
    const records = Array.from({ length: 60 }, (_, i) => closed(i, new Date(2026, 0, 1, 0, 0, i).toISOString()));
    expect(trimHistory(records)).toHaveLength(50);
  });

  it("does not mutate the input array", () => {
    const records = [closed(1, "2026-01-01T00:00:00.000Z"), closed(2, "2026-01-02T00:00:00.000Z")];
    const copy = [...records];
    trimHistory(records);
    expect(records).toEqual(copy);
  });
});
