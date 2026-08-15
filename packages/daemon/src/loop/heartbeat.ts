import { FLEET_LABELS, type ProjectConfig } from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import {
  getStatusCommentInfo,
  markReady,
  refreshHeartbeat,
  refreshHeartbeatIfStale,
  removeAssignee,
  upsertStatusComment,
  type ReadyIssue,
  type StatusCommentInfo,
} from "../github/github.ts";
import { log, logError } from "../log.ts";

/** `TicketRecord` statuses this daemon should keep a fresh heartbeat on, once per cycle, while it's the one actually working the ticket. */
const IN_FLIGHT_STATUSES = new Set(["running", "needs-input"]);

/** Only refresh once the last heartbeat is older than half the staleness threshold — avoids a `gh` PATCH every cycle for every in-flight ticket. */
export function heartbeatRefreshAgeMs(staleClaimMinutes: number): number {
  return (staleClaimMinutes * 60_000) / 2;
}

/**
 * Whether a peer daemon should treat `comment` as a dead claim: no status
 * comment at all is too ambiguous to act on (a ticket can sit `fleet:ready`
 * for a while after claim before anything posts a comment); a comment with
 * no heartbeat line falls back to the comment's own creation time (a
 * pre-heartbeat claim, aged out the same way); otherwise it's the heartbeat
 * timestamp itself.
 */
export function isClaimStale(comment: StatusCommentInfo | undefined, now: number, staleClaimMinutes: number): boolean {
  if (!comment) return false;
  const referenceTs = comment.heartbeat?.timestamp ?? comment.createdAt;
  return now - Date.parse(referenceTs) >= staleClaimMinutes * 60_000;
}

/** Refreshes the heartbeat on every ticket this daemon currently owns and is actively working — running or needs-input — gated by age. */
export async function refreshOwnHeartbeats(ctx: LoopContext): Promise<void> {
  for (const record of ctx.state.all()) {
    if (!IN_FLIGHT_STATUSES.has(record.status)) continue;
    const project = ctx.getProject(record.project);
    if (!project) continue;
    const scope = key(record.project, record.issueNumber);
    if (ctx.dryRun) {
      log("loop", `[dry-run] would refresh heartbeat for ${scope} if stale`);
      continue;
    }
    try {
      await refreshHeartbeatIfStale(project, record.issueNumber, heartbeatRefreshAgeMs(ctx.config.staleClaimMinutes));
    } catch (err) {
      logError("loop", `${scope}: could not refresh heartbeat`, err);
    }
  }
}

/**
 * Boot-only: force a fresh heartbeat onto every one of this daemon's own
 * `stalled` tickets, so a quick restart's recovery window never looks stale
 * to a peer — `refreshOwnHeartbeats` above only touches `running`/`needs-input`
 * records, and a ticket sits `stalled` locally (label still `fleet:in-progress`
 * on GitHub) from `clearLiveFlags()` until `recoverStalled` resumes it.
 */
export async function refreshStalledHeartbeatsOnBoot(ctx: LoopContext): Promise<void> {
  for (const record of ctx.state.all()) {
    if (record.status !== "stalled") continue;
    const project = ctx.getProject(record.project);
    if (!project) continue;
    const scope = key(record.project, record.issueNumber);
    if (ctx.dryRun) {
      log("loop", `[dry-run] would refresh heartbeat for ${scope} on boot`);
      continue;
    }
    try {
      await refreshHeartbeat(project, record.issueNumber);
    } catch (err) {
      logError("loop", `${scope}: could not refresh heartbeat on boot`, err);
    }
  }
}

const RELEASABLE_STATUS_LABELS = [FLEET_LABELS.inProgress, FLEET_LABELS.needsInput];

/**
 * Releases `project`'s open `fleet:in-progress`/`fleet:needs-input` issues
 * that are assigned to someone other than this daemon and whose status
 * comment's heartbeat has gone stale — the dead-daemon recovery path.
 * `fleet:review` is deliberately excluded: the PR already exists there, so
 * nothing but review-feedback automation is stuck on the dead daemon, and
 * auto-releasing would orphan an open PR. Racing another observing daemon is
 * fine — every step below is idempotent via `gh` (unassigning an absent
 * assignee, re-adding an existing label are no-ops) — but the annotate step
 * runs first regardless, so a release that dies partway through still leaves
 * the ticket visibly explained before the next step makes it claimable again.
 */
export async function releaseStaleClaims(
  ctx: LoopContext,
  project: ProjectConfig,
  issues: ReadyIssue[],
  myLogin: string,
): Promise<void> {
  const now = Date.now();
  for (const issue of issues) {
    if (!RELEASABLE_STATUS_LABELS.some((label) => issue.labels.includes(label))) continue;
    const others = (issue.assignees ?? []).filter((login) => login !== myLogin);
    if (others.length === 0) continue;

    const comment = await getStatusCommentInfo(project, issue.number);
    if (!isClaimStale(comment, now, ctx.config.staleClaimMinutes)) continue;

    const scope = key(project.name, issue.number);
    const ownerList = others.join(", ");
    log("loop", `${scope}: stale claim from @${ownerList} (no heartbeat within ${ctx.config.staleClaimMinutes}m) — releasing to the pool`);
    try {
      await upsertStatusComment(
        project,
        issue.number,
        [
          `**Status: released**`,
          `Released due to a stale heartbeat from @${ownerList} — returned to the pool for another daemon to claim.`,
        ].join("\n\n"),
      );
      for (const login of others) await removeAssignee(project, issue.number, login);
      await markReady(project, issue.number);
    } catch (err) {
      logError("loop", `${scope}: could not finish releasing the stale claim`, err);
    }
  }
}
