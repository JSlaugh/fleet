export type TicketStatus =
  | "running"
  | "stalled"
  | "needs-input"
  | "review"
  | "failed"
  /** Operator hit Restart: the old session is gone and the issue is back in `fleet:ready`, awaiting a fresh claim. */
  | "restarting";

export interface TicketRecord {
  project: string;
  issueNumber: number;
  issueTitle: string;
  branch: string;
  worktreePath: string;
  sessionId?: string;
  status: TicketStatus;
  startedAt: string;
  lastActivityAt: string;
  costUsd: number;
  prUrl?: string;
  lastSummary?: string;
  sessionLive?: boolean;
  model?: string;
  modelUsage?: Record<string, ModelUsageSummary>;
  lastActivityNote?: string;
  elevated?: boolean;
  light?: boolean;
  autoResumed?: boolean;
  isPlan?: boolean;
  /** Set once this ticket has auto-retried on the elevated model after a failure — caps escalation to once, ever. */
  autoElevated?: boolean;
  /** The epic issue number this ticket was filed under, parsed from its `Part-of: #<epic>` body line at claim time. */
  epicNumber?: number;
  /** ISO timestamp watermark: PR reviews/comments at or before this have already been fed back into the session. */
  lastReviewHandledAt?: string;
  /**
   * ISO timestamp watermark: issue comments at or before this have already
   * been considered for mid-flight injection (whether that meant relaying
   * them into the session or ignoring them as noise/non-collaborator). Set at
   * claim time to the claim moment, since the first prompt already includes
   * every comment that exists then.
   */
  lastCommentHandledAt?: string;
  /**
   * Once-per-conflict-episode guard: set when a CONFLICTING PR has already
   * earned its one automatic resolution resume, cleared as soon as the PR
   * reports MERGEABLE again so a later, distinct conflict is eligible too.
   */
  conflictHandled?: boolean;
  /**
   * Machine pre-review outcome — doubles as the once-per-ticket cap: any value
   * (including "pending", which survives a crash mid-review) means a review was
   * already attempted, so later completions skip straight to human review.
   */
  machineReviewOutcome?: "pending" | "passed" | "findings" | "skipped";
  /**
   * The immediately-preceding attempt's closing summary or failure reason,
   * captured by `resetForFreshClaim` before a restart overwrites `lastSummary`
   * with restart boilerplate. Folded into the next session's opening prompt
   * (`buildPriorAttemptBlock`) and not itself carried forward past that —
   * the fresh claim's own record replaces it.
   */
  priorAttemptSummary?: string;
}

export interface ModelUsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Per-model usage is cumulative only within a single SDK session, so resuming a
 * ticket restarts the counters. Sum the running total already on the record with
 * the live session's usage instead of overwriting it.
 */
export function mergeModelUsage(
  base: Record<string, ModelUsageSummary> | undefined,
  delta: Record<string, ModelUsageSummary> | undefined,
): Record<string, ModelUsageSummary> | undefined {
  if (!base && !delta) return undefined;
  const out: Record<string, ModelUsageSummary> = { ...base };
  for (const [model, usage] of Object.entries(delta ?? {})) {
    const prev = out[model];
    out[model] = prev
      ? {
          inputTokens: prev.inputTokens + usage.inputTokens,
          outputTokens: prev.outputTokens + usage.outputTokens,
          costUsd: prev.costUsd + usage.costUsd,
        }
      : { ...usage };
  }
  return out;
}

export function shortModelName(model: string | undefined): string {
  if (!model) return "";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export interface PendingApproval {
  id: string;
  project: string;
  issueNumber: number;
  toolName: string;
  kind: "permission" | "question";
  input: unknown;
  createdAt: string;
}

export interface WorkerQuestionOption {
  label: string;
  description?: string;
}

export interface WorkerQuestion {
  question: string;
  header?: string;
  options?: WorkerQuestionOption[];
  multiSelect?: boolean;
}

export function parseWorkerQuestions(input: unknown): WorkerQuestion[] {
  if (typeof input !== "object" || input === null) return [];
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.filter(
    (q): q is WorkerQuestion => typeof q === "object" && q !== null && typeof (q as WorkerQuestion).question === "string",
  );
}

export interface FleetState {
  tickets: TicketRecord[];
  /** ISO timestamp: set while the daemon is paused on a plan usage-limit hit, cleared once it passes. */
  pausedUntil?: string;
  /** Operator-initiated drain mode: survives a restart, cleared only by an explicit resume. */
  paused?: boolean;
  /** Project names an operator has individually paused: survives a restart, cleared only by an explicit resume. A name no longer in config is harmlessly ignored. */
  pausedProjects?: string[];
  /**
   * Daemon-wide rolling spend ledger backing the `windowBudgetUsd` claim gate:
   * one entry per recorded cost delta (never a running total), timestamped so
   * the window sum can be recomputed and stale entries pruned. Absent/empty
   * when the budget feature is unused.
   */
  spendLedger?: SpendLedgerEntry[];
}

export interface SpendLedgerEntry {
  at: string;
  usd: number;
}
