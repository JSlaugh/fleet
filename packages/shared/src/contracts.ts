import { z } from "zod";

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

export const MachineReviewResultSchema = z.object({
  verdict: z.enum(["pass", "findings"]).describe("pass = the diff is ready for human review; findings = the worker should do one fix round first"),
  summary: z.string().describe("1-3 sentence overall assessment of the diff, written for the ticket's status comment"),
  findings: z.array(z.object({
    file: z.string().describe("Repo-relative path of the file the finding is in"),
    line: z.number().int().optional().describe("Line number the finding anchors to, if known"),
    severity: z.enum(["blocker", "major", "minor"]).optional().describe("blocker = must not ship; major = real defect; minor = worth fixing while we're here"),
    summary: z.string().describe("One-sentence statement of the defect"),
    detail: z.string().describe("Why it's wrong and what a fix needs to do"),
  })).default([]).describe("Concrete, actionable defects only — empty when verdict is pass"),
});
export type MachineReviewResult = z.infer<typeof MachineReviewResultSchema>;

export const PlanResultSchema = z.object({
  status: z.enum(["completed", "blocked"]).describe("completed = tickets[] is ready to file as child issues; blocked = a human decision is needed before this epic can be decomposed"),
  summary: z.string().describe("2-5 sentence plain-language summary of the decomposition (or what's blocking it), written for the plan issue's status comment"),
  tickets: z.array(z.object({
    title: z.string().describe("Concise title for the child ticket"),
    body: z.string().describe("Full issue body for the child ticket, in markdown with a `## Problem`, `## Acceptance criteria`, and `## Verification` heading each — self-contained, independently implementable, and PR-sized"),
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
