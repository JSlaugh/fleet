import { FLEET_LABELS, statusLabelsOf, type FleetStatusLabel, type ProjectConfig, type TicketRecord } from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import { listFleetIssues, setStatusLabel } from "../github/github.ts";
import { log, logError } from "../log.ts";

/** The status label a ticket's state record says it should carry. */
const LABEL_FOR_RECORD_STATUS: Record<TicketRecord["status"], FleetStatusLabel> = {
  running: FLEET_LABELS.inProgress,
  // Stall recovery resumes from `fleet:in-progress`; a stalled ticket is still this daemon's.
  stalled: FLEET_LABELS.inProgress,
  "needs-input": FLEET_LABELS.needsInput,
  // Every failure path that leaves the record `failed` without re-queuing it ends in needs-input.
  failed: FLEET_LABELS.needsInput,
  review: FLEET_LABELS.review,
  restarting: FLEET_LABELS.ready,
};

/**
 * Which single status label an issue carrying several should be left with:
 * the one its state record implies, else (no record — e.g. a peer daemon's
 * ticket) the most advanced one it already has, so a running ticket is never
 * demoted to claimable. `undefined` when there is no conflict to fix. Pure.
 */
export function resolveStatusLabelConflict(labels: string[], record: TicketRecord | undefined): FleetStatusLabel | undefined {
  const present = statusLabelsOf(labels);
  if (present.length <= 1) return undefined;
  return record ? LABEL_FOR_RECORD_STATUS[record.status] : present[0];
}

/**
 * One-time boot repair (fleet#239): before `setStatusLabel` existed, a resume
 * could add `fleet:in-progress` beside a `fleet:ready` auto-escalation had
 * left, so a running ticket looked claimable. Any issue still carrying more
 * than one status label is normalized from its state record, one log line per
 * fix. Best-effort per project and per issue — a failure is logged and the
 * claim-side conflict guard in `selectEligibleReady` still holds the ticket.
 */
export async function repairStatusLabels(ctx: LoopContext): Promise<void> {
  for (const project of ctx.config.projects) {
    await repairProject(ctx, project).catch((err) =>
      logError("labels", `${project.name}: could not check for conflicting status labels`, err),
    );
  }
}

async function repairProject(ctx: LoopContext, project: ProjectConfig): Promise<void> {
  for (const issue of await listFleetIssues(project)) {
    const record = ctx.state.get(project.name, issue.number);
    const target = resolveStatusLabelConflict(issue.labels, record);
    if (!target) continue;
    const scope = key(project.name, issue.number);
    const was = statusLabelsOf(issue.labels).join(" + ");
    const why = record ? `record status ${record.status}` : "no record, kept the most advanced";
    if (ctx.dryRun) {
      log("labels", `[dry-run] ${scope}: would normalize ${was} → ${target} (${why})`);
      continue;
    }
    try {
      await setStatusLabel(project, issue.number, target);
      log("labels", `${scope}: normalized conflicting status labels ${was} → ${target} (${why})`);
    } catch (err) {
      logError("labels", `${scope}: could not normalize conflicting status labels ${was}`, err);
    }
  }
}
