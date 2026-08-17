import type { ClosedTicketRecord } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { makeRecord } from "../test-support.ts";
import { computeHistoryAggregates, queryHistory } from "./history.ts";

function closedRecord(patch: Partial<ClosedTicketRecord> = {}): ClosedTicketRecord {
  const record = makeRecord({
    issueNumber: 1,
    issueTitle: "A ticket",
    branch: "fleet/1",
    worktreePath: "/tmp/wt/1",
    status: "review",
    lastActivityAt: "2026-01-01T00:30:00.000Z",
    costUsd: 1,
  });
  return { ...record, closedAt: "2026-01-01T01:00:00.000Z", prState: "MERGED", ...patch };
}

describe("computeHistoryAggregates", () => {
  it("produces sane, zeroed aggregates for an empty history (no division by zero, no NaN)", () => {
    const aggregates = computeHistoryAggregates([]);
    expect(aggregates).toEqual({
      count: 0,
      totalCostUsd: 0,
      meanCostUsd: 0,
      meanDurationMs: 0,
      prStateCounts: { MERGED: 0, CLOSED: 0, NONE: 0 },
      elevatedRate: 0,
      lightRate: 0,
      autoResumedRate: 0,
      planRate: 0,
      modelTotals: {},
      bashDeniedByModel: {},
      approvalLatency: { count: 0, totalWaitMs: 0, maxWaitMs: 0 },
      machineReviewOutcomeCounts: { pending: 0, passed: 0, findings: 0, skipped: 0, none: 0 },
    });
  });

  it("does not NaN or throw on tickets that predate bash-denied/approval-latency/machine-review fields", () => {
    const record = closedRecord({});
    expect(record.bashDeniedCount).toBeUndefined();
    expect(record.approvalLatency).toBeUndefined();
    expect(record.machineReviewOutcome).toBeUndefined();

    const aggregates = computeHistoryAggregates([record]);

    expect(aggregates.bashDeniedByModel).toEqual({});
    expect(aggregates.approvalLatency).toEqual({ count: 0, totalWaitMs: 0, maxWaitMs: 0 });
    expect(aggregates.machineReviewOutcomeCounts).toEqual({ pending: 0, passed: 0, findings: 0, skipped: 0, none: 1 });
  });

  it("rolls up bash-denied counts by model, approval latency, and machine-review outcomes", () => {
    const records = [
      closedRecord({
        issueNumber: 1,
        model: "claude-sonnet-5",
        bashDeniedCount: 2,
        approvalLatency: { count: 2, totalWaitMs: 3000, maxWaitMs: 2000 },
        machineReviewOutcome: "findings",
      }),
      closedRecord({
        issueNumber: 2,
        model: "claude-sonnet-5",
        bashDeniedCount: 1,
        approvalLatency: { count: 1, totalWaitMs: 5000, maxWaitMs: 5000 },
        machineReviewOutcome: "passed",
      }),
      closedRecord({
        issueNumber: 3,
        model: "claude-opus-5",
        machineReviewOutcome: "skipped",
      }),
    ];

    const aggregates = computeHistoryAggregates(records);

    expect(aggregates.bashDeniedByModel).toEqual({ "claude-sonnet-5": 3 });
    expect(aggregates.approvalLatency).toEqual({ count: 3, totalWaitMs: 8000, maxWaitMs: 5000 });
    expect(aggregates.machineReviewOutcomeCounts).toEqual({ pending: 0, passed: 1, findings: 1, skipped: 1, none: 0 });
  });

  it("computes correct aggregates for a single record", () => {
    const record = closedRecord({
      costUsd: 2.5,
      startedAt: "2026-01-01T00:00:00.000Z",
      closedAt: "2026-01-01T00:10:00.000Z",
      elevated: true,
      modelUsage: { "claude-opus-5": { inputTokens: 100, outputTokens: 50, costUsd: 2.5 } },
    });
    const aggregates = computeHistoryAggregates([record]);
    expect(aggregates.count).toBe(1);
    expect(aggregates.totalCostUsd).toBe(2.5);
    expect(aggregates.meanCostUsd).toBe(2.5);
    expect(aggregates.meanDurationMs).toBe(10 * 60 * 1000);
    expect(aggregates.prStateCounts).toEqual({ MERGED: 1, CLOSED: 0, NONE: 0 });
    expect(aggregates.elevatedRate).toBe(1);
    expect(aggregates.lightRate).toBe(0);
    expect(aggregates.autoResumedRate).toBe(0);
    expect(aggregates.planRate).toBe(0);
    expect(aggregates.modelTotals).toEqual({ "claude-opus-5": { inputTokens: 100, outputTokens: 50, costUsd: 2.5 } });
  });

  it("rolls up rates, PR states, and per-model totals across a mixed set", () => {
    const records = [
      closedRecord({
        issueNumber: 1,
        costUsd: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        closedAt: "2026-01-01T00:10:00.000Z",
        prState: "MERGED",
        elevated: true,
        modelUsage: { "claude-sonnet-5": { inputTokens: 10, outputTokens: 5, costUsd: 1, cacheReadTokens: 2, cacheCreationTokens: 1 } },
      }),
      closedRecord({
        issueNumber: 2,
        costUsd: 3,
        startedAt: "2026-01-02T00:00:00.000Z",
        closedAt: "2026-01-02T00:20:00.000Z",
        prState: "CLOSED",
        light: true,
        autoResumed: true,
        modelUsage: { "claude-sonnet-5": { inputTokens: 20, outputTokens: 10, costUsd: 3, cacheReadTokens: 4, cacheCreationTokens: 2 } },
      }),
      closedRecord({
        issueNumber: 3,
        costUsd: 0,
        startedAt: "2026-01-03T00:00:00.000Z",
        closedAt: "2026-01-03T00:00:00.000Z",
        prState: "NONE",
        isPlan: true,
        modelUsage: { "claude-opus-5": { inputTokens: 5, outputTokens: 2, costUsd: 0.5, cacheReadTokens: 1, cacheCreationTokens: 0 } },
      }),
    ];

    const aggregates = computeHistoryAggregates(records);
    expect(aggregates.count).toBe(3);
    expect(aggregates.totalCostUsd).toBe(4);
    expect(aggregates.meanCostUsd).toBeCloseTo(4 / 3);
    expect(aggregates.meanDurationMs).toBeCloseTo((10 * 60 * 1000 + 20 * 60 * 1000 + 0) / 3);
    expect(aggregates.prStateCounts).toEqual({ MERGED: 1, CLOSED: 1, NONE: 1 });
    expect(aggregates.elevatedRate).toBeCloseTo(1 / 3);
    expect(aggregates.lightRate).toBeCloseTo(1 / 3);
    expect(aggregates.autoResumedRate).toBeCloseTo(1 / 3);
    expect(aggregates.planRate).toBeCloseTo(1 / 3);
    expect(aggregates.modelTotals).toEqual({
      "claude-sonnet-5": { inputTokens: 30, outputTokens: 15, costUsd: 4, cacheReadTokens: 6, cacheCreationTokens: 3 },
      "claude-opus-5": { inputTokens: 5, outputTokens: 2, costUsd: 0.5, cacheReadTokens: 1, cacheCreationTokens: 0 },
    });
  });
});

describe("queryHistory", () => {
  const records = [
    closedRecord({ project: "alpha", issueNumber: 1, closedAt: "2026-01-01T00:00:00.000Z" }),
    closedRecord({ project: "beta", issueNumber: 2, closedAt: "2026-01-02T00:00:00.000Z" }),
    closedRecord({ project: "alpha", issueNumber: 3, closedAt: "2026-01-03T00:00:00.000Z" }),
  ];

  it("returns everything newest-first when unfiltered", () => {
    const page = queryHistory(records);
    expect(page.total).toBe(3);
    expect(page.records.map((r) => r.issueNumber)).toEqual([3, 2, 1]);
    expect(page.aggregates.count).toBe(3);
  });

  it("filters by project and computes aggregates over the filtered set", () => {
    const page = queryHistory(records, { project: "alpha" });
    expect(page.total).toBe(2);
    expect(page.records.map((r) => r.issueNumber)).toEqual([3, 1]);
    expect(page.aggregates.count).toBe(2);
  });

  it("filters by since/until on closedAt", () => {
    const page = queryHistory(records, { since: "2026-01-02T00:00:00.000Z", until: "2026-01-02T23:59:59.000Z" });
    expect(page.records.map((r) => r.issueNumber)).toEqual([2]);
    expect(page.total).toBe(1);
  });

  it("paginates with limit/offset while total reflects the full filtered set", () => {
    const page = queryHistory(records, { limit: 1, offset: 1 });
    expect(page.total).toBe(3);
    expect(page.records.map((r) => r.issueNumber)).toEqual([2]);
    expect(page.aggregates.count).toBe(3);
  });

  it("defaults to a limit of 50 when none is given", () => {
    const page = queryHistory(records);
    expect(page.records.length).toBe(3);
  });
});
