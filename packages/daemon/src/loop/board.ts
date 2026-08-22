import type { BoardTicket, ClosedTicketRecord, ProjectConfig } from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import { run } from "../github/exec.ts";
import { getPrOutcome, getPrState, type PrOutcome } from "../github/github.ts";
import { log, logError } from "../log.ts";
import { deleteRemoteBranch, removeWorktree } from "../github/worktree.ts";
import { readJournalTail, summarizeJournalEvents } from "../store/journal.ts";
import { copyTicketTranscripts } from "../store/transcripts.ts";
import { teardownTicket } from "./teardown.ts";

/** GitHub issue URL for a ticket record, or "" if its project isn't in the current config (e.g. removed since it closed). */
export function issueUrl(
  projects: { name: string; githubRepo: string }[],
  record: { project: string; issueNumber: number },
): string {
  const project = projects.find((p) => p.name === record.project);
  return project ? `https://github.com/${project.githubRepo}/issues/${record.issueNumber}` : "";
}

/**
 * Synthesizes Done-column board tickets from archived history: the most
 * recently closed tickets overall (newest first), capped at `limit`. The
 * project filter on the dashboard narrows this further client-side, so no
 * per-project limit is applied here.
 */
export function synthesizeDoneTickets(
  history: ClosedTicketRecord[],
  projects: { name: string; githubRepo: string }[],
  limit = 5,
): BoardTicket[] {
  return [...history]
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
    .slice(0, limit)
    .map((record) => ({
      project: record.project,
      issueNumber: record.issueNumber,
      title: record.issueTitle,
      url: issueUrl(projects, record),
      status: "done" as const,
      priority: null,
      type: record.ticketType ?? null,
      isPlan: record.isPlan ?? false,
      ...(record.epicNumber !== undefined ? { epicNumber: record.epicNumber } : {}),
      record,
    }));
}

/** The dashboard board: this cycle's polled tickets joined to their live records, plus the Done column. */
export function getBoard(ctx: LoopContext): BoardTicket[] {
  const active = [...ctx.boardCache.values()].flat().map((t) => ({
    ...t,
    record: ctx.state.get(t.project, t.issueNumber),
  }));
  return [...active, ...synthesizeDoneTickets(ctx.history.all(), ctx.config.projects)];
}

/**
 * Individually-paused project names, for the board payload — filtered to
 * projects still in config so a name left over from one since removed
 * doesn't leak into the dashboard.
 */
export function pausedProjectNames(ctx: LoopContext): string[] {
  const configured = new Set(ctx.config.projects.map((p) => p.name));
  return ctx.state.getPausedProjects().filter((name) => configured.has(name));
}

/**
 * Operator-pinned-dormant project names, for the board payload — filtered to
 * projects still in config, same as `pausedProjectNames`. Purely a dashboard
 * display toggle (#152): dormant projects still claim/resume/poll as normal.
 */
export function dormantProjectNames(ctx: LoopContext): string[] {
  const configured = new Set(ctx.config.projects.map((p) => p.name));
  return ctx.state.getDormantProjects().filter((name) => configured.has(name));
}

/**
 * Retires finished tickets: the worktree, local branch and remote branch go
 * away, and the record moves from live state into history so the Done column
 * can still show it. Most tickets need both their PR and issue closed; a plan
 * epic never opens a PR (`finishPlanned` files child issues instead), so for
 * `isPlan` records the closed issue alone is the completion signal.
 */
export async function cleanupFinished(
  ctx: LoopContext,
  project: ProjectConfig,
  openIssues: { number: number }[],
): Promise<void> {
  const openNumbers = new Set(openIssues.map((i) => i.number));
  for (const record of ctx.state.all()) {
    if (record.project !== project.name) continue;
    if (record.status !== "review") continue;
    if (!record.prUrl && !record.isPlan) continue;
    if (openNumbers.has(record.issueNumber)) continue;
    if (ctx.running.has(key(record.project, record.issueNumber))) continue;

    const scope = key(record.project, record.issueNumber);
    let prState: "MERGED" | "CLOSED" | "NONE";
    if (record.prUrl) {
      let rawPrState: string;
      try {
        rawPrState = await getPrState(project, record.prUrl);
      } catch (err) {
        logError("loop", `${scope}: could not check PR state`, err);
        continue;
      }
      if (rawPrState !== "MERGED" && rawPrState !== "CLOSED") continue;
      prState = rawPrState;
    } else {
      prState = "NONE";
    }

    // Best-effort: this only enriches the archived record with outcome data
    // (time-to-merge, review rounds, ...) — a failed fetch here shouldn't
    // block cleanup itself, which is why prState above (which gates whether
    // cleanup proceeds at all) is checked separately.
    let outcome: PrOutcome | undefined;
    if (record.prUrl) {
      try {
        outcome = await getPrOutcome(project, record.prUrl);
      } catch (err) {
        logError("loop", `${scope}: could not fetch PR outcome details`, err);
      }
    }

    const reason = record.prUrl ? `PR ${prState.toLowerCase()} and issue closed` : "plan epic issue closed";
    log("loop", `${scope}: ${reason} — cleaning up worktree + branch ${record.branch}`);
    copyTicketTranscripts(ctx.dataDirPath, record);
    // Before the worktree goes: release whatever per-worktree resources its
    // setup provisioned (no-op unless the claim flagged teardownPending).
    await teardownTicket(ctx, project, record);
    // allowFailure keeps cleanup rolling, but a Windows file lock here leaks
    // the worktree dir forever (the record is removed below regardless) — so a
    // failure must at least be visible in the log.
    const removed = await removeWorktree(project, record.worktreePath);
    if (removed.stderr.trim()) log("loop", `${scope}: worktree removal reported: ${removed.stderr.trim()} — the directory may be leaked`);
    const pruned = await run("git", ["-C", project.repoPath, "branch", "-D", record.branch], { allowFailure: true });
    if (pruned.stderr.trim()) log("loop", `${scope}: local branch delete reported: ${pruned.stderr.trim()}`);
    await deleteRemoteBranch(project, record.branch);
    // Snapshotted once here so cross-ticket history aggregates never need to
    // re-scan a journal — see `summarizeJournalEvents`.
    const journal = readJournalTail(ctx.dataDirPath, record.project, record.issueNumber, Number.MAX_SAFE_INTEGER);
    const { bashDeniedCount, approvalLatency } = summarizeJournalEvents(journal);
    ctx.history.add({
      ...record,
      closedAt: new Date().toISOString(),
      prState,
      bashDeniedCount,
      approvalLatency,
      ...(outcome
        ? {
            timeToMergeMs: outcome.timeToMergeMs,
            humanPushedAfterOpen: outcome.humanPushedAfterOpen,
            reviewRounds: outcome.reviewRounds,
            reviewCommentCount: outcome.reviewCommentCount,
          }
        : {}),
    });
    ctx.state.remove(record.project, record.issueNumber);
    ctx.emitBoard();
  }
}
