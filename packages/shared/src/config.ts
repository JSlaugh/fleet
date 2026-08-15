import { z } from "zod";

export const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  repoPath: z.string().min(1),
  githubRepo: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/repo"),
  defaultBranch: z.string().default("main"),
  maxConcurrent: z.number().int().min(1).default(1),
  maxInReview: z.number().int().min(1).default(3),
  setupCommand: z.string().optional(),
  model: z.string().optional(),
  elevatedModel: z.string().optional(),
  lightModel: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  planChildrenReady: z.boolean().default(false),
  autoElevateOnFailure: z.boolean().default(true),
  autoAddressReviews: z.boolean().default(true),
  machineReview: z.boolean().default(true),
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
  /** Added to a parsed plan-limit reset time before resuming, to absorb clock skew and reset-boundary jitter. */
  limitResumeSlackMinutes: z.number().int().min(0).default(5),
  /** Pause length used when a plan-limit hit is detected but no reset time could be parsed out of it. */
  limitDefaultBackoffMinutes: z.number().int().min(1).default(300),
  claudeExecutable: z.string().optional(),
  dataDir: z.string().default(".fleet"),
  projects: z.array(ProjectConfigSchema).min(1),
});
export type FleetConfig = z.infer<typeof FleetConfigSchema>;
