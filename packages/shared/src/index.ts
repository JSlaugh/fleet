import { z } from "zod";

export const FLEET_LABELS = {
  ready: "fleet:ready",
  inProgress: "fleet:in-progress",
  needsInput: "fleet:needs-input",
  review: "fleet:review",
} as const;

export const PRIORITY_LABELS = ["fleet:p1", "fleet:p2", "fleet:p3"] as const;

export const ALL_FLEET_LABELS: { name: string; color: string; description: string }[] = [
  { name: FLEET_LABELS.ready, color: "0e8a16", description: "Eligible for pickup by a fleet worker" },
  { name: FLEET_LABELS.inProgress, color: "fbca04", description: "A fleet worker session is on it" },
  { name: FLEET_LABELS.needsInput, color: "d93f0b", description: "Worker is blocked on a human decision" },
  { name: FLEET_LABELS.review, color: "1d76db", description: "PR open, awaiting human review" },
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
  allowedTools: z.array(z.string()).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const FleetConfigSchema = z.object({
  pollIntervalSeconds: z.number().int().min(10).default(60),
  worktreeRoot: z.string().min(1),
  stalledAfterMinutes: z.number().int().min(1).default(10),
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

export type TicketStatus =
  | "claimed"
  | "running"
  | "stalled"
  | "needs-input"
  | "review"
  | "failed";

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
}

export interface FleetState {
  tickets: TicketRecord[];
}
