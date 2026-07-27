import { FLEET_LABELS, type ProjectConfig, type TicketRecord } from "@fleet/shared";
import { countRunning, key, track, type LoopContext } from "./context.ts";
import { buildReviewFeedbackPrompt, getPrFeedback, swapLabel, type PrFeedback } from "./github.ts";
import { log, logError } from "./log.ts";
import { resumeTicket } from "./runner.ts";

/**
 * Ticket records eligible for PR-review-feedback resumption this cycle: sitting
 * in `review` with a PR and a resumable session, not already in flight, their
 * issue still open, and the project hasn't opted out.
 */
export function pickReviewCandidates(
  records: TicketRecord[],
  project: { name: string; autoAddressReviews?: boolean },
  openIssueNumbers: ReadonlySet<number>,
  runningKeys: Iterable<string>,
): TicketRecord[] {
  if (project.autoAddressReviews === false) return [];
  const running = new Set(runningKeys);
  return records.filter(
    (record) =>
      record.project === project.name &&
      record.status === "review" &&
      !!record.prUrl &&
      !!record.sessionId &&
      openIssueNumbers.has(record.issueNumber) &&
      !running.has(key(record.project, record.issueNumber)),
  );
}

/** Approved-with-no-comment reviews (and no fresh inline comments) trigger nothing. */
export function shouldActOnFeedback(feedback: Pick<PrFeedback, "hasChangesRequested" | "reviews" | "comments">): boolean {
  return feedback.hasChangesRequested || feedback.reviews.length > 0 || feedback.comments.length > 0;
}

/**
 * Changes-requested reviews (or fresh inline comments) on an open fleet PR
 * resume that ticket's session in its existing worktree/branch. Runs before
 * claiming new `fleet:ready` issues so in-flight work gets capacity first;
 * the per-candidate active-count check below is what makes it count against
 * `maxConcurrent` rather than bypassing it.
 */
export async function addressReviews(
  ctx: LoopContext,
  project: ProjectConfig,
  openIssueNumbers: ReadonlySet<number>,
): Promise<void> {
  const candidates = pickReviewCandidates(ctx.state.all(), project, openIssueNumbers, ctx.running.keys());

  for (const record of candidates) {
    if (countRunning(ctx.running.keys(), project.name) >= project.maxConcurrent) return;

    const scope = key(project.name, record.issueNumber);
    let feedback: PrFeedback;
    try {
      feedback = await getPrFeedback(project, record.prUrl as string, record.lastReviewHandledAt);
    } catch (err) {
      logError("loop", `${scope}: could not fetch PR review feedback`, err);
      continue;
    }
    if (!shouldActOnFeedback(feedback) || !feedback.latestAt) continue;

    // Watermark set before resuming so a crash can't reprocess the same feedback.
    ctx.state.update(project.name, record.issueNumber, { lastReviewHandledAt: feedback.latestAt });
    await swapLabel(project, record.issueNumber, FLEET_LABELS.review, FLEET_LABELS.inProgress);
    log("loop", `${scope}: PR review feedback arrived — resuming session ${record.sessionId}`);
    track(ctx, project.name, record.issueNumber, resumeTicket(ctx, project, record, buildReviewFeedbackPrompt(feedback)));
  }
}
