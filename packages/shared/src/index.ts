import { z } from "zod";

export const FLEET_LABELS = {
  ready: "fleet:ready",
  inProgress: "fleet:in-progress",
  needsInput: "fleet:needs-input",
  review: "fleet:review",
} as const;

export const PRIORITY_LABELS = ["fleet:p1", "fleet:p2", "fleet:p3"] as const;

export const ELEVATE_LABEL = "fleet:elevate";

export const LIGHT_LABEL = "fleet:light";

export const PLAN_LABEL = "fleet:plan";

export const ALL_FLEET_LABELS: { name: string; color: string; description: string }[] = [
  { name: FLEET_LABELS.ready, color: "0e8a16", description: "Eligible for pickup by a fleet worker" },
  { name: FLEET_LABELS.inProgress, color: "fbca04", description: "A fleet worker session is on it" },
  { name: FLEET_LABELS.needsInput, color: "d93f0b", description: "Worker is blocked on a human decision" },
  { name: FLEET_LABELS.review, color: "1d76db", description: "PR open, awaiting human review" },
  { name: ELEVATE_LABEL, color: "5319e7", description: "Run this ticket on the project's elevated model" },
  { name: LIGHT_LABEL, color: "bfd4f2", description: "Run this ticket on the project's light model" },
  { name: PLAN_LABEL, color: "c2e0c6", description: "Decompose this epic into child tickets instead of coding it" },
  { name: "fleet:p1", color: "b60205", description: "Highest priority" },
  { name: "fleet:p2", color: "d93f0b", description: "Medium priority" },
  { name: "fleet:p3", color: "fef2c0", description: "Low priority" },
];

export const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  repoPath: z.string().min(1),
  githubRepo: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/repo"),
  defaultBranch: z.string().default("main"),
  maxConcurrent: z.number().int().min(1).default(1),
  setupCommand: z.string().optional(),
  model: z.string().optional(),
  elevatedModel: z.string().optional(),
  lightModel: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  planChildrenReady: z.boolean().default(false),
  autoElevateOnFailure: z.boolean().default(true),
  autoAddressReviews: z.boolean().default(true),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const FleetConfigSchema = z.object({
  pollIntervalSeconds: z.number().int().min(10).default(60),
  dashboardPort: z.number().int().min(1).default(4400),
  worktreeRoot: z.string().min(1),
  stalledAfterMinutes: z.number().int().min(1).default(10),
  ticketTimeoutMinutes: z.number().int().min(1).default(30),
  approvalTimeoutMinutes: z.number().int().min(1).default(10),
  replyWaitMinutes: z.number().int().min(1).default(60),
  claudeExecutable: z.string().optional(),
  dataDir: z.string().default(".fleet"),
  projects: z.array(ProjectConfigSchema).min(1),
});
export type FleetConfig = z.infer<typeof FleetConfigSchema>;

export const WorkerResultSchema = z.object({
  status: z.enum(["completed", "blocked"]).describe("completed = work is committed and ready for a PR; blocked = a human decision is needed before work can continue"),
  summary: z.string().describe("2-5 sentence plain-language summary of what was done (or attempted), written for the ticket's status comment"),
  filesChanged: z.array(z.string()).describe("Repo-relative paths of files created or modified"),
  prTitle: z.string().optional().describe("Conventional-commit style title for the PR (required when status is completed)"),
  prBody: z.string().optional().describe("PR description in markdown: what changed, why, and how it was verified (required when status is completed)"),
  blockedReason: z.string().optional().describe("The specific question or decision a human must answer (required when status is blocked)"),
  confidence: z.enum(["low", "medium", "high"]).describe("How confident you are that the change is correct and complete"),
});
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export const PlanResultSchema = z.object({
  status: z.enum(["completed", "blocked"]).describe("completed = tickets[] is ready to file as child issues; blocked = a human decision is needed before this epic can be decomposed"),
  summary: z.string().describe("2-5 sentence plain-language summary of the decomposition (or what's blocking it), written for the plan issue's status comment"),
  tickets: z.array(z.object({
    title: z.string().describe("Concise title for the child ticket"),
    body: z.string().describe("Full issue body for the child ticket: it must be self-contained (problem statement, acceptance criteria, and how to verify it), independently implementable, and PR-sized"),
    priority: z.enum(["fleet:p1", "fleet:p2", "fleet:p3"]).optional().describe("Priority label to apply to the child issue, if any"),
    tier: z
      .enum(["light", "standard", "elevated"])
      .optional()
      .describe(
        "Suggested model tier for this child ticket, judged honestly by complexity: light = mechanical/small-surface (doc tweaks, renames, simple sweeps), elevated = cross-cutting or design-heavy work, standard = everything else (default)",
      ),
  })).describe("Independent, PR-sized child tickets decomposed from this epic; each must be self-contained (problem, acceptance criteria, verification) and independently implementable"),
  blockedReason: z.string().optional().describe("The specific question or decision a human must answer (required when status is blocked)"),
  confidence: z.enum(["low", "medium", "high"]).describe("How confident you are that this decomposition is correct and complete"),
});
export type PlanResult = z.infer<typeof PlanResultSchema>;

export type TicketStatus =
  | "claimed"
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
  /** ISO timestamp watermark: PR reviews/comments at or before this have already been fed back into the session. */
  lastReviewHandledAt?: string;
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
}

export type BoardStatus = "ready" | "in-progress" | "needs-input" | "review";

export const BOARD_COLUMNS: { status: BoardStatus; title: string }[] = [
  { status: "ready", title: "Ready" },
  { status: "in-progress", title: "In progress" },
  { status: "needs-input", title: "Needs input" },
  { status: "review", title: "In review" },
];

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
  record?: TicketRecord;
}

export function boardStatusFromLabels(labels: string[]): BoardStatus | null {
  if (labels.includes(FLEET_LABELS.ready)) return "ready";
  if (labels.includes(FLEET_LABELS.inProgress)) return "in-progress";
  if (labels.includes(FLEET_LABELS.needsInput)) return "needs-input";
  if (labels.includes(FLEET_LABELS.review)) return "review";
  return null;
}

export function priorityOf(labels: string[]): string | null {
  return PRIORITY_LABELS.find((p) => labels.includes(p)) ?? null;
}

export interface JournalEntry {
  ts: string;
  type: string;
  subtype?: string;
  text?: string;
  tools?: string[];
  costUsd?: number;
  [key: string]: unknown;
}

export interface TicketDetail {
  ticket?: BoardTicket;
  record?: TicketRecord;
  journal: JournalEntry[];
}
