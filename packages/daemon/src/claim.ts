import { ELEVATE_LABEL, FLEET_LABELS, LIGHT_LABEL, PLAN_LABEL, type BoardTicket, type ProjectConfig } from "@fleet/shared";
import { cleanupFinished } from "./board.ts";
import { countRunning, key, track, type LoopContext } from "./context.ts";
import { reportRunFailure } from "./finish.ts";
import {
  dependencyStatus,
  getIssueComments,
  listFleetIssues,
  listIssueStates,
  parseDependsOn,
  swapLabel,
  toBoardTicket,
  type ReadyIssue,
} from "./github.ts";
import { Journal } from "./journal.ts";
import { log } from "./log.ts";
import { addressReviews } from "./reviews.ts";
import { runSession } from "./runner.ts";
import { buildIssuePrompt } from "./worker.ts";
import { createWorktree } from "./worktree.ts";

/**
 * The `fleet:ready` issues that are actually claimable this cycle: not already
 * in flight, and with every `Depends-on` reference satisfied (closed, or
 * pointing at an issue number this repo has never had). Preserves the input
 * order, which callers sort by priority-then-number before this filter runs.
 */
export function selectEligibleReady(
  issues: ReadyIssue[],
  opts: {
    openIssueNumbers: ReadonlySet<number>;
    allIssueNumbers: ReadonlySet<number>;
    isRunning: (issueNumber: number) => boolean;
  },
): ReadyIssue[] {
  return issues.filter((issue) => {
    if (!issue.labels.includes(FLEET_LABELS.ready)) return false;
    if (opts.isRunning(issue.number)) return false;
    const { blockedBy } = dependencyStatus(parseDependsOn(issue.body), opts.openIssueNumbers, opts.allIssueNumbers);
    return blockedBy.length === 0;
  });
}

/**
 * One project's slice of a poll cycle: refresh its board projection, clean up
 * finished tickets, let in-flight work claim capacity first (PR review
 * feedback), then claim `fleet:ready` issues with whatever capacity is left.
 */
export async function cycleProject(ctx: LoopContext, project: ProjectConfig, paused: boolean): Promise<void> {
  const issues = await listFleetIssues(project);
  const { open: openIssueNumbers, all: allIssueNumbers } = await listIssueStates(project);

  const blockedByIssue = new Map<number, number[]>();
  for (const issue of issues) {
    const { blockedBy, unknown } = dependencyStatus(parseDependsOn(issue.body), openIssueNumbers, allIssueNumbers);
    for (const n of unknown) {
      log("loop", `${key(project.name, issue.number)}: Depends-on references #${n}, which doesn't exist in this repo — treating as satisfied`);
    }
    blockedByIssue.set(issue.number, blockedBy);
  }

  ctx.boardCache.set(
    project.name,
    issues
      .map((issue) => toBoardTicket(project, issue, blockedByIssue.get(issue.number)))
      .filter((t): t is BoardTicket => t !== null),
  );
  ctx.emitBoard();

  if (ctx.dryRun) {
    log("loop", `[dry-run] would clean up finished tickets for ${project.name}`);
  } else {
    await cleanupFinished(ctx, project, issues);
  }

  if (paused) return;

  if (ctx.dryRun) {
    log("loop", `[dry-run] would check ${project.name} for PR review feedback to address`);
  } else {
    await addressReviews(ctx, project, openIssueNumbers);
  }

  const capacity = project.maxConcurrent - countRunning(ctx.running.keys(), project.name);
  if (capacity <= 0) return;

  const ready = selectEligibleReady(issues, {
    openIssueNumbers,
    allIssueNumbers,
    isRunning: (issueNumber) => ctx.running.has(key(project.name, issueNumber)),
  });

  for (const issue of ready.slice(0, Math.max(0, capacity))) {
    if (ctx.dryRun) {
      log("loop", `[dry-run] would claim ${project.name}#${issue.number}: ${issue.title}`);
      continue;
    }
    track(ctx, project.name, issue.number, processTicket(ctx, project, issue));
  }
}

/** Claims a ready issue: label swap, fresh worktree + branch, state record, then a session. */
export async function processTicket(ctx: LoopContext, project: ProjectConfig, issue: ReadyIssue): Promise<void> {
  const now = new Date().toISOString();
  const scope = key(project.name, issue.number);
  log("loop", `claiming ${scope}: ${issue.title}`);

  try {
    await swapLabel(project, issue.number, FLEET_LABELS.ready, FLEET_LABELS.inProgress);
    const comments = await getIssueComments(project, issue.number);
    const worktree = await createWorktree(project, issue.number, ctx.config.worktreeRoot);

    const elevated = issue.labels.includes(ELEVATE_LABEL);
    const light = issue.labels.includes(LIGHT_LABEL);
    const isPlan = issue.labels.includes(PLAN_LABEL);
    // A fresh claim otherwise wipes the once-only escalation guard along with
    // everything else the prior attempt recorded — carry it forward so a
    // second failure (now elevated) can't trigger a second auto-escalation.
    const autoElevated = ctx.state.get(project.name, issue.number)?.autoElevated ?? false;
    ctx.state.upsert({
      project: project.name,
      issueNumber: issue.number,
      issueTitle: issue.title,
      branch: worktree.branch,
      worktreePath: worktree.path,
      status: "running",
      startedAt: now,
      lastActivityAt: now,
      costUsd: 0,
      elevated,
      light,
      isPlan,
      autoElevated,
    });

    const journal = new Journal(ctx.dataDirPath, project.name, issue.number);
    journal.append({ type: "fleet", event: "claimed", issue: issue.number, title: issue.title, elevated, light, isPlan });

    await runSession(ctx, {
      project,
      issue,
      worktree,
      journal,
      firstMessage: buildIssuePrompt(project, issue, comments),
      elevated,
      light,
      kind: isPlan ? "plan" : "code",
    });
  } catch (err) {
    await reportRunFailure(ctx, project, issue, "failed", err);
  }
}
