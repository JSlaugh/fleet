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

export const WORK_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WorkDay = (typeof WORK_DAYS)[number];

export const WorkHoursReserveSchema = z.object({
  /** Local machine time, 24h HH:MM, when the workday starts. */
  workStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM"),
  days: z.array(z.enum(WORK_DAYS)).default(["mon", "tue", "wed", "thu", "fri"]),
  /** Hours of hard claim hold immediately before `workStart` on each configured day. */
  reserveHours: z.number().min(0),
});
export type WorkHoursReserveConfig = z.infer<typeof WorkHoursReserveSchema>;

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
  /**
   * Rolling-window self-estimated spend cap, summed from fleet's own spend
   * ledger — unset (default) disables the budget gate entirely. This is a
   * governor, not a guarantee: interactive Claude use on the same plan is
   * invisible to it.
   */
  windowBudgetUsd: z.number().min(0).optional(),
  /** Rolling window the budget above is measured over — mirrors the plan's own rolling window. */
  usageWindowHours: z.number().min(0.1).default(5),
  /** Fraction of `windowBudgetUsd` past which new claims are restricted to `fleet:light` issues. */
  budgetLightThreshold: z.number().min(0).max(1).default(0.85),
  claudeExecutable: z.string().optional(),
  dataDir: z.string().default(".fleet"),
  /**
   * Hard stop on new claims for `reserveHours` before `workStart` on each
   * configured day, so the plan's usage window is back at full capacity when
   * the human's workday begins. Unset (default) disables the feature —
   * resumes and already-live sessions are never held back either way.
   */
  workHoursReserve: WorkHoursReserveSchema.optional(),
  projects: z.array(ProjectConfigSchema).min(1),
});
export type FleetConfig = z.infer<typeof FleetConfigSchema>;
