import type { ModelUsageSummary, TicketRecord } from "./tickets.ts";

export type BoardStatus = "ready" | "in-progress" | "needs-input" | "review" | "done";

export const BOARD_COLUMNS: { status: BoardStatus; title: string }[] = [
  { status: "ready", title: "Ready" },
  { status: "in-progress", title: "In progress" },
  { status: "needs-input", title: "Needs input" },
  { status: "review", title: "In review" },
  { status: "done", title: "Done" },
];

/**
 * A ticket's final record, archived at cleanup time once its PR and issue
 * both close — or, for a PR-less plan epic, once its issue alone closes
 * (`prState: "NONE"`).
 */
export interface ClosedTicketRecord extends TicketRecord {
  closedAt: string;
  prState: "MERGED" | "CLOSED" | "NONE";
}

/** A `ClosedTicketRecord` enriched with the GitHub issue URL, for the history view's table rows. */
export interface HistoryRecord extends ClosedTicketRecord {
  url: string;
}

/** Cross-ticket rollups over a (possibly filtered) slice of history — see `computeHistoryAggregates`. */
export interface HistoryAggregates {
  count: number;
  totalCostUsd: number;
  meanCostUsd: number;
  meanDurationMs: number;
  prStateCounts: Record<"MERGED" | "CLOSED" | "NONE", number>;
  elevatedRate: number;
  lightRate: number;
  autoResumedRate: number;
  planRate: number;
  modelTotals: Record<string, ModelUsageSummary>;
}

/** `GET /api/history` response: a newest-first page of archived tickets plus aggregates over the full filtered set. */
export interface HistoryResponse {
  records: HistoryRecord[];
  total: number;
  aggregates: HistoryAggregates;
}

export type BudgetGateLevel = "none" | "light-only" | "blocked";

/** Rolling-window spend gate status for the board payload — present only when `windowBudgetUsd` is configured. */
export interface BudgetStatus {
  spentUsd: number;
  budgetUsd: number;
  windowHours: number;
  gate: BudgetGateLevel;
}

/** Work-hours reserve status for the board payload — present only when `workHoursReserve` is configured. */
export interface WorkHoursReserveStatus {
  active: boolean;
  /** ISO timestamp claims resume at — set only while `active`. */
  releaseAt?: string;
}

export interface BoardTicket {
  project: string;
  issueNumber: number;
  title: string;
  url: string;
  status: BoardStatus;
  priority: string | null;
  isPlan: boolean;
  /** Unsatisfied `Depends-on` issue numbers — only set while they're still open. */
  blockedBy?: number[];
  /** A `ClosedTicketRecord` when `status` is `"done"`, a live `TicketRecord` otherwise. */
  record?: TicketRecord | ClosedTicketRecord;
}

export interface JournalEntry {
  ts: string;
  type: string;
  subtype?: string;
  text?: string;
  tools?: string[];
  costUsd?: number;
  event?: string;
  /** Set to "machine-review" on entries from the one-shot reviewer sub-session, which shares this journal file but is not the ticket's own worker turn. */
  session?: string;
  toolCalls?: { id: string; name: string }[];
  toolResults?: { id: string; isError?: boolean }[];
  numTurns?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export interface TicketDetail {
  ticket?: BoardTicket;
  record?: TicketRecord | ClosedTicketRecord;
  journal: JournalEntry[];
  /** Whether `restartTicket`/`reply` would actually accept this ticket right now — the dashboard gates its buttons on these rather than duplicating the daemon's policy. */
  canRestart: boolean;
  canReply: boolean;
}

/** One resumption of the worker: from a `claimed`/`resumed` fleet event through the next `result` entry. */
export interface SessionSegmentReport {
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number;
}

/** Server-side aggregation of a ticket's full journal — derived and read-only, tolerant of journals written before any per-tool digest/error/turn enrichment existed. */
export interface TicketReport {
  toolCounts: Record<string, number>;
  toolErrorCounts: Record<string, number>;
  errorCount: number;
  segments: SessionSegmentReport[];
  totals: {
    toolCalls: number;
    errors: number;
    turns: number;
    durationMs: number;
    costUsd: number;
  };
}
