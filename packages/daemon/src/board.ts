import type { BoardTicket, ClosedTicketRecord, ProjectConfig } from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import { run } from "./exec.ts";
import { getPrState } from "./github.ts";
import { log, logError } from "./log.ts";
import { deleteRemoteBranch, removeWorktree } from "./worktree.ts";

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
    .map((record) => {
      const project = projects.find((p) => p.name === record.project);
      return {
        project: record.project,
        issueNumber: record.issueNumber,
        title: record.issueTitle,
        url: project ? `https://github.com/${project.githubRepo}/issues/${record.issueNumber}` : "",
        status: "done" as const,
        priority: null,
        isPlan: record.isPlan ?? false,
        record,
      };
    });
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
 * Retires tickets whose PR and issue have both closed: the worktree, local
 * branch and remote branch go away, and the record moves from live state into
 * history so the Done column can still show it.
 */
export async function cleanupFinished(
  ctx: LoopContext,
  project: ProjectConfig,
  openIssues: { number: number }[],
): Promise<void> {
  const openNumbers = new Set(openIssues.map((i) => i.number));
  for (const record of ctx.state.all()) {
    if (record.project !== project.name) continue;
    if (record.status !== "review" || !record.prUrl) continue;
    if (openNumbers.has(record.issueNumber)) continue;
    if (ctx.running.has(key(record.project, record.issueNumber))) continue;

    const scope = key(record.project, record.issueNumber);
    let rawPrState: string;
    try {
      rawPrState = await getPrState(project, record.prUrl);
    } catch (err) {
      logError("loop", `${scope}: could not check PR state`, err);
      continue;
    }
    if (rawPrState !== "MERGED" && rawPrState !== "CLOSED") continue;
    const prState: "MERGED" | "CLOSED" = rawPrState;

    log("loop", `${scope}: PR ${prState.toLowerCase()} and issue closed — cleaning up worktree + branch ${record.branch}`);
    await removeWorktree(project, record.worktreePath);
    await run("git", ["-C", project.repoPath, "branch", "-D", record.branch], { allowFailure: true });
    await deleteRemoteBranch(project, record.branch);
    ctx.history.add({ ...record, closedAt: new Date().toISOString(), prState });
    ctx.state.remove(record.project, record.issueNumber);
    ctx.emitBoard();
  }
}
