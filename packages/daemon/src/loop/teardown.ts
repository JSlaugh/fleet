import { existsSync } from "node:fs";
import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import { runTeardown } from "../github/worktree.ts";
import { Journal } from "../store/journal.ts";
import { log, logError } from "../log.ts";

/**
 * Tears down one ticket's per-worktree resources if (and only if) its claim
 * flagged `teardownPending`. Journals the attempt and clears the flag, so
 * each provisioned worktree is torn down at most once and a crash between
 * removal and teardown is visible to startup recovery. Never throws — a
 * teardown problem is logged, never allowed to block the caller's cleanup,
 * restart, or re-claim.
 */
export async function teardownTicket(
  ctx: LoopContext,
  project: ProjectConfig,
  record: Pick<TicketRecord, "issueNumber" | "worktreePath" | "ticketType" | "teardownPending">,
): Promise<void> {
  if (!record.teardownPending) return;
  const scope = key(project.name, record.issueNumber);
  try {
    const journal = new Journal(ctx.dataDirPath, project.name, record.issueNumber);
    journal.append({ type: "fleet", event: "teardown-started", ticketType: record.ticketType });
    const outcome = await runTeardown(project, record.issueNumber, record.worktreePath, record.ticketType);
    journal.append({
      type: "fleet",
      event: "teardown-completed",
      ran: outcome !== undefined,
      failures: outcome?.failures ?? [],
    });
    if (outcome && outcome.failures.length > 0) {
      log("loop", `${scope}: teardown finished with ${outcome.failures.length} failed step(s) — resources may be leaked`);
    }
  } catch (err) {
    logError("loop", `${scope}: teardown failed`, err);
  }
  ctx.state.update(project.name, record.issueNumber, { teardownPending: false });
}

/**
 * Boot-only sweep for tickets whose worktree directory is already gone but
 * whose teardown never ran — the daemon died (or the directory was removed
 * by hand) between worktree removal and teardown. Tickets whose worktree
 * still exists are left alone: whichever path eventually discards that
 * worktree tears down first.
 */
export async function recoverPendingTeardowns(ctx: LoopContext): Promise<void> {
  for (const record of ctx.state.all()) {
    if (!record.teardownPending) continue;
    if (existsSync(record.worktreePath)) continue;
    const project = ctx.getProject(record.project);
    if (!project) continue;
    const scope = key(record.project, record.issueNumber);
    if (ctx.dryRun) {
      log("loop", `[dry-run] would run pending teardown for ${scope} (worktree already gone)`);
      continue;
    }
    log("loop", `${scope}: worktree is gone but teardown never ran — running it now`);
    await teardownTicket(ctx, project, record);
  }
}
