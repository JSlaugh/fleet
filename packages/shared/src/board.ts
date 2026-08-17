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
  /** PR opened → merged, in ms. Undefined unless `prState` is `"MERGED"`, or when the PR outcome fetch failed at cleanup. */
  timeToMergeMs?: number;
  /**
   * Whether a commit landed on the fleet branch, authored by someone other
   * than the daemon's own GitHub login, after the PR opened — the best
   * available proxy for "a human reworked the worker's output" (a resumed
   * worker session pushes under the same login, so it doesn't count).
   * Undefined when the PR outcome fetch failed at cleanup.
   */
  humanPushedAfterOpen?: boolean;
  /** Total PR review submissions (approvals, change requests, plain comments). Undefined when the PR outcome fetch failed at cleanup. */
  reviewRounds?: number;
  /** Total inline PR review comments. Undefined when the PR outcome fetch failed at cleanup. */
  reviewCommentCount?: number;
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
  /** The epic issue number this ticket is `Part-of`, parsed from its body — only set on children. */
  epicNumber?: number;
  /** For an epic (`isPlan`) with a filed `## Children` task list: how many of its children are closed. */
  epicProgress?: { closed: number; total: number };
  /** A `ClosedTicketRecord` when `status` is `"done"`, a live `TicketRecord` otherwise. */
  record?: TicketRecord | ClosedTicketRecord;
}

/** Per-message token usage carried on an assistant entry — undefined fields mean the SDK message didn't report that count. */
export interface JournalMessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface JournalEntry {
  /** Schema version; absent on entries written before this field existed (treat as 1). */
  v?: number;
  ts: string;
  type: string;
  subtype?: string;
  /** Assistant text, or plain user/operator steering text on a `"user"`-type entry (tool-result entries carry no `text`). */
  text?: string;
  /** Extended-thinking content on an `"assistant"`-type entry. */
  thinking?: string;
  tools?: string[];
  costUsd?: number;
  event?: string;
  /** Set to "machine-review" on entries from the one-shot reviewer sub-session, which shares this journal file but is not the ticket's own worker turn. */
  session?: string;
  usage?: JournalMessageUsage;
  toolCalls?: { id: string; name: string }[];
  /** `durationMs`/`outputSize`/`error` are set when the matching `tool_use` was seen earlier in the same session, only present since `v: 2`. */
  toolResults?: { id: string; isError?: boolean; durationMs?: number; outputSize?: number; error?: string }[];
  numTurns?: number;
  durationMs?: number;
  [key: string]: unknown;
}

/** One ticket surfaced in a digest bucket — a project-scoped, single-line summary with a link back to the issue. */
export interface DigestTicketItem {
  project: string;
  issueNumber: number;
  title: string;
  url: string;
  prUrl?: string;
  costUsd?: number;
  /** Set on the blocked/failed buckets: the worker's blocked question, or the one-line failure reason. */
  reason?: string;
}

/** One `fleet:in-progress`/`fleet:needs-input` claim a peer daemon released back to the pool as dead. */
export interface DigestStaleRelease {
  project: string;
  issueNumber: number;
  title: string;
  url: string;
  owners: string[];
  at: string;
}

export type DigestGateType = "budget" | "work-hours" | "plan-limit";

/** One instance of a claim gate (budget/work-hours/plan-limit) actually holding claims during the digest window. */
export interface DigestGateHold {
  gate: DigestGateType;
  at: string;
  project?: string;
  detail: string;
}

/** One project's slice of a `DigestResponse` — see `computeDigest`. */
export interface ProjectDigest {
  project: string;
  /** Completed and pushed a PR, currently awaiting review. */
  completed: DigestTicketItem[];
  autoMerged: DigestTicketItem[];
  blocked: DigestTicketItem[];
  failed: DigestTicketItem[];
  staleReleases: DigestStaleRelease[];
  /** Sum of `costUsd` across every ticket surfaced above for this project — not a windowed spend figure, see `totalSpendUsd` for that. */
  spendUsd: number;
}

/** `GET /api/digest` response: what happened across every project in the trailing `windowHours`. */
export interface DigestResponse {
  windowHours: number;
  since: string;
  until: string;
  projects: ProjectDigest[];
  /** The daemon's self-estimated spend actually incurred during `[since, until]`, from the same ledger `windowBudgetUsd` gates on. */
  totalSpendUsd: number;
  /** Present only when `windowBudgetUsd` is configured — the budget gate's own window, not necessarily `windowHours`. */
  budget?: { budgetUsd: number; windowHours: number };
  gateHolds: DigestGateHold[];
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
