import type { ApprovalLatencyStats, ClosedTicketRecord, HistoryAggregates, ModelUsageSummary } from "@fleet/shared";

const DEFAULT_LIMIT = 50;

export interface HistoryQuery {
  project?: string;
  /** ISO timestamp: keeps records with `closedAt >= since`. */
  since?: string;
  /** ISO timestamp: keeps records with `closedAt <= until`. */
  until?: string;
  limit?: number;
  offset?: number;
}

export interface HistoryPage {
  records: ClosedTicketRecord[];
  total: number;
  aggregates: HistoryAggregates;
}

function matchesQuery(record: ClosedTicketRecord, query: HistoryQuery): boolean {
  if (query.project && record.project !== query.project) return false;
  const closedAt = Date.parse(record.closedAt);
  if (query.since && closedAt < Date.parse(query.since)) return false;
  if (query.until && closedAt > Date.parse(query.until)) return false;
  return true;
}

/** Rolls per-model usage across every record's `modelUsage` map into one totals-by-model map. */
function sumModelUsage(records: ClosedTicketRecord[]): Record<string, ModelUsageSummary> {
  const totals: Record<string, ModelUsageSummary> = {};
  for (const record of records) {
    for (const [model, usage] of Object.entries(record.modelUsage ?? {})) {
      const prev = totals[model];
      totals[model] = prev
        ? {
            inputTokens: prev.inputTokens + usage.inputTokens,
            outputTokens: prev.outputTokens + usage.outputTokens,
            costUsd: prev.costUsd + usage.costUsd,
            cacheReadTokens: (prev.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
            cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
          }
        : { ...usage };
    }
  }
  return totals;
}

/** Rolls each record's `bashDeniedCount` into a total keyed by its assigned model — absent on records predating #157, or on a record with no `model` set. */
function sumBashDeniedByModel(records: ClosedTicketRecord[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const record of records) {
    if (!record.bashDeniedCount) continue;
    const model = record.model ?? "unknown";
    totals[model] = (totals[model] ?? 0) + record.bashDeniedCount;
  }
  return totals;
}

/** Sums each record's `approvalLatency` — `count`/`totalWaitMs` add cleanly; `maxWaitMs` is the max of maxes. Absent on records predating #157. */
function sumApprovalLatency(records: ClosedTicketRecord[]): ApprovalLatencyStats {
  return records.reduce<ApprovalLatencyStats>(
    (acc, record) => {
      const latency = record.approvalLatency;
      if (!latency) return acc;
      return {
        count: acc.count + latency.count,
        totalWaitMs: acc.totalWaitMs + latency.totalWaitMs,
        maxWaitMs: Math.max(acc.maxWaitMs, latency.maxWaitMs),
      };
    },
    { count: 0, totalWaitMs: 0, maxWaitMs: 0 },
  );
}

/** Counts each record's `machineReviewOutcome` — `"none"` covers both an opted-out project and a ticket that predates the field. */
function countMachineReviewOutcomes(records: ClosedTicketRecord[]): HistoryAggregates["machineReviewOutcomeCounts"] {
  const counts: HistoryAggregates["machineReviewOutcomeCounts"] = { pending: 0, passed: 0, findings: 0, skipped: 0, none: 0 };
  for (const record of records) {
    const outcome = record.machineReviewOutcome ?? "none";
    counts[outcome] += 1;
  }
  return counts;
}

/** Pure rollup over an already-filtered slice of history — every rate is 0 (not NaN) when `records` is empty. */
export function computeHistoryAggregates(records: ClosedTicketRecord[]): HistoryAggregates {
  const count = records.length;
  const totalCostUsd = records.reduce((sum, r) => sum + r.costUsd, 0);
  const durations = records
    .map((r) => Date.parse(r.closedAt) - Date.parse(r.startedAt))
    .filter((ms) => Number.isFinite(ms));
  const rateOf = (pred: (r: ClosedTicketRecord) => boolean): number =>
    count > 0 ? records.filter(pred).length / count : 0;

  return {
    count,
    totalCostUsd,
    meanCostUsd: count > 0 ? totalCostUsd / count : 0,
    meanDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    prStateCounts: {
      MERGED: records.filter((r) => r.prState === "MERGED").length,
      CLOSED: records.filter((r) => r.prState === "CLOSED").length,
      NONE: records.filter((r) => r.prState === "NONE").length,
    },
    elevatedRate: rateOf((r) => r.elevated === true),
    lightRate: rateOf((r) => r.light === true),
    autoResumedRate: rateOf((r) => r.autoResumed === true),
    planRate: rateOf((r) => r.isPlan === true),
    modelTotals: sumModelUsage(records),
    bashDeniedByModel: sumBashDeniedByModel(records),
    approvalLatency: sumApprovalLatency(records),
    machineReviewOutcomeCounts: countMachineReviewOutcomes(records),
  };
}

/**
 * Filters `all` by project/date range, sorts newest-first, and pages the
 * result — aggregates are computed over the *filtered* set (not just the
 * returned page), so the rollups stay accurate across pagination.
 */
export function queryHistory(all: ClosedTicketRecord[], query: HistoryQuery = {}): HistoryPage {
  const filtered = [...all]
    .filter((r) => matchesQuery(r, query))
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;
  return {
    records: filtered.slice(offset, offset + limit),
    total: filtered.length,
    aggregates: computeHistoryAggregates(filtered),
  };
}
