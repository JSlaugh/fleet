import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { countRunning, key, type LoopContext } from "./context.ts";
import { getPushCollaborators, getTimestampedIssueComments, isNewerThan, type TimestampedComment } from "../github/github.ts";
import { log, logError } from "../log.ts";
import { reply, ticketCapabilities } from "./operator.ts";

/** Ticket statuses steerable by an issue comment. `review` has its own feedback channel (`addressReviews`). */
const COMMENTABLE_STATUSES = new Set<TicketRecord["status"]>(["running", "needs-input"]);

/**
 * Ticket records eligible for issue-comment ingestion this cycle: `running` or
 * `needs-input`, with the issue still open. Unlike PR-review candidates, being
 * already in flight does not disqualify a record here — a `running` ticket
 * with a live session is exactly the common case this exists to steer.
 */
export function pickCommentCandidates(
  records: TicketRecord[],
  project: { name: string },
  openIssueNumbers: ReadonlySet<number>,
): TicketRecord[] {
  return records.filter(
    (record) =>
      record.project === project.name &&
      COMMENTABLE_STATUSES.has(record.status) &&
      openIssueNumbers.has(record.issueNumber),
  );
}

/** Batches new collaborator comments into one message, framed as human guidance for the worker to incorporate. */
export function buildCommentPrompt(comments: { author: string; body: string }[]): string {
  return [
    "New comments on the issue from a human reviewer:",
    comments.map((c) => `@${c.author}: ${c.body}`).join("\n\n"),
  ].join("\n\n");
}

/**
 * Newer-than-watermark issue comments, from push collaborators only, batched
 * and routed into a `running`/`needs-input` ticket's session — the mid-flight
 * counterpart to the comments a fresh claim already folds into its first
 * prompt. Routing goes through `reply()`'s own eligibility (`ticketCapabilities`)
 * so this can never accept a ticket a dashboard reply would refuse; a ticket
 * caught mid-transition between phases is simply left for next cycle with its
 * watermark untouched, rather than dropped.
 */
export async function addressComments(
  ctx: LoopContext,
  project: ProjectConfig,
  openIssueNumbers: ReadonlySet<number>,
): Promise<void> {
  const candidates = pickCommentCandidates(ctx.state.all(), project, openIssueNumbers);

  for (const record of candidates) {
    const scope = key(project.name, record.issueNumber);

    const { canReply } = ticketCapabilities(ctx, project.name, record.issueNumber, true);
    if (!canReply) continue;

    // A cold resume (no live session, no parked reply waiter) is new work the
    // way a stall-recovery or review-feedback resume is, so it must respect
    // the project's concurrency cap the way those do — unlike a dashboard
    // reply, an explicit human action `reply()` never gates on capacity.
    const isColdResume = !ctx.replyWaiters.has(scope) && !ctx.live.has(scope);
    if (isColdResume && countRunning(ctx.running.keys(), project.name) >= project.maxConcurrent) continue;

    let comments: TimestampedComment[];
    try {
      comments = await getTimestampedIssueComments(project, record.issueNumber);
    } catch (err) {
      logError("loop", `${scope}: could not fetch issue comments`, err);
      continue;
    }
    const fresh = comments.filter((c) => isNewerThan(c.createdAt, record.lastCommentHandledAt));
    if (fresh.length === 0) continue;
    const latestAt = fresh.reduce((latest, c) => (Date.parse(c.createdAt) > Date.parse(latest.createdAt) ? c : latest)).createdAt;

    let collaborators: Set<string>;
    try {
      collaborators = await getPushCollaborators(project);
    } catch (err) {
      logError("loop", `${scope}: could not fetch repo collaborators — leaving new comments for next cycle`, err);
      continue;
    }

    const eligible: TimestampedComment[] = [];
    for (const comment of fresh) {
      if (comment.isStatusComment) continue;
      if (collaborators.has(comment.author)) {
        eligible.push(comment);
      } else {
        log("loop", `${scope}: ignoring comment from non-collaborator @${comment.author}`);
      }
    }

    // Written before injecting — same discipline as `lastReviewHandledAt` — so
    // a crash between the two can't reprocess the same comments. A cycle with
    // nothing eligible (all status/non-collaborator) still advances: those
    // comments were handled, by being ignored.
    ctx.state.update(project.name, record.issueNumber, { lastCommentHandledAt: latestAt });
    if (eligible.length === 0) continue;

    try {
      const outcome = await reply(ctx, project.name, record.issueNumber, buildCommentPrompt(eligible));
      log("loop", `${scope}: ${eligible.length} new comment(s) ${outcome} into the session`);
    } catch (err) {
      logError("loop", `${scope}: could not route new comments into the session`, err);
    }
  }
}
