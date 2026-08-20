import type { DatabaseSync } from "node:sqlite";
import type { ApprovalLatencyStats, JournalEntry, TicketReportFinding, TicketReportMachineReview } from "@fleet/shared";
import { insertJournalEntry, journalEntriesTail, openDatabase } from "./db.ts";

export class Journal {
  private readonly db: DatabaseSync;

  constructor(dataDir: string, private readonly project: string, private readonly issueNumber: number) {
    this.db = openDatabase(dataDir);
  }

  append(entry: Record<string, unknown>): void {
    insertJournalEntry(this.db, this.project, this.issueNumber, {
      v: 2,
      ts: new Date().toISOString(),
      ...entry,
    } as JournalEntry);
  }
}

/** The most recent `limit` entries of a ticket's journal, oldest first. A ticket with no entries yet yields an empty array. */
export function readJournalTail(dataDir: string, project: string, issueNumber: number, limit: number): JournalEntry[] {
  return journalEntriesTail(openDatabase(dataDir), project, issueNumber, limit);
}

/** The `session` tag review.ts's `runReviewSession` stamps onto every message of a one-shot reviewer sub-session — see `isReviewSessionEntry`. */
const REVIEW_SESSION_TAGS = new Set(["machine-review", "plan-review"]);

/**
 * Whether a journal entry belongs to the one-shot machine-review or
 * plan-review reviewer sub-session rather than the ticket's own worker turn —
 * both share the ticket's journal file (see review.ts's `runReviewSession`),
 * so anything rolling up "the worker's own session" (tool counts, cache
 * tokens, segments) needs to exclude both tags, not just one.
 */
export function isReviewSessionEntry(entry: JournalEntry): boolean {
  return typeof entry.session === "string" && REVIEW_SESSION_TAGS.has(entry.session);
}

export interface JournalEventSummary {
  bashDeniedCount: number;
  approvalLatency: ApprovalLatencyStats;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  machineReview?: TicketReportMachineReview;
}

/**
 * Pure rollup of the `type: "fleet"` events and per-message cache usage #131
 * started journaling — `bash-denied` firings, `approval-decided` wait times,
 * cache-read/cache-creation tokens, and the once-per-ticket machine/plan-review
 * attempt (started/passed/findings/error). Shared by the per-ticket report
 * (`buildTicketReport`) and by `cleanupFinished`, which snapshots the
 * bash-denied/approval-latency pieces onto the archived `ClosedTicketRecord` so
 * cross-ticket history aggregates never need to re-scan a journal.
 *
 * Skips the machine-review/plan-review sub-session's own entries (see
 * `isReviewSessionEntry`) the same way `buildTicketReport` does — those are a
 * separate one-shot reviewer turn, not the ticket's own worker session.
 */
export function summarizeJournalEvents(journal: JournalEntry[]): JournalEventSummary {
  let bashDeniedCount = 0;
  const approvalWaits: number[] = [];
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let reviewKind: "code" | "plan" | undefined;
  let reviewModel: string | undefined;
  let reviewOutcome: TicketReportMachineReview["outcome"] | undefined;
  let reviewFindings: TicketReportFinding[] = [];
  let reviewErrorSubtype: string | undefined;

  for (const entry of journal) {
    if (isReviewSessionEntry(entry)) continue;

    if (entry.type === "fleet" && entry.event === "bash-denied") {
      bashDeniedCount += 1;
    }

    if (entry.type === "fleet" && entry.event === "approval-decided") {
      approvalWaits.push(typeof entry.waitMs === "number" ? entry.waitMs : 0);
    }

    if (entry.type === "fleet" && (entry.event === "machine-review-started" || entry.event === "plan-review-started")) {
      reviewKind = entry.event === "plan-review-started" ? "plan" : "code";
      reviewModel = typeof entry.model === "string" ? entry.model : undefined;
      if (reviewOutcome === undefined) reviewOutcome = "pending";
    }
    if (entry.type === "fleet" && (entry.event === "machine-review-passed" || entry.event === "plan-review-passed")) {
      reviewOutcome = "passed";
    }
    if (entry.type === "fleet" && (entry.event === "machine-review-findings" || entry.event === "plan-review-findings")) {
      reviewOutcome = "findings";
      reviewFindings = Array.isArray(entry.findings) ? (entry.findings as TicketReportFinding[]) : [];
    }
    if (entry.type === "fleet" && (entry.event === "machine-review-error" || entry.event === "plan-review-error")) {
      reviewOutcome = "error";
      reviewErrorSubtype = typeof entry.errorSubtype === "string" ? entry.errorSubtype : undefined;
    }

    if (entry.type === "assistant" && entry.usage && typeof entry.usage === "object") {
      const usage = entry.usage as { cacheReadTokens?: unknown; cacheCreationTokens?: unknown };
      if (typeof usage.cacheReadTokens === "number") cacheReadTokens += usage.cacheReadTokens;
      if (typeof usage.cacheCreationTokens === "number") cacheCreationTokens += usage.cacheCreationTokens;
    }
  }

  return {
    bashDeniedCount,
    approvalLatency: {
      count: approvalWaits.length,
      totalWaitMs: approvalWaits.reduce((sum, ms) => sum + ms, 0),
      maxWaitMs: approvalWaits.length > 0 ? Math.max(...approvalWaits) : 0,
    },
    cacheReadTokens,
    cacheCreationTokens,
    machineReview:
      reviewKind && reviewOutcome
        ? { kind: reviewKind, outcome: reviewOutcome, model: reviewModel, findings: reviewFindings, errorSubtype: reviewErrorSubtype }
        : undefined,
  };
}
