import { FLEET_LABELS, type ProjectConfig, type TicketRecord } from "@fleet/shared";
import { countRunning, key, track, type LoopContext } from "./context.ts";
import {
  buildConflictPrompt,
  buildReviewFeedbackPrompt,
  getPrFeedback,
  getPrMergeable,
  swapLabel,
  type PrFeedback,
  type PrMergeable,
} from "../github/github.ts";
import { log, logError } from "../log.ts";
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
 * A CONFLICTING PR earns exactly one automatic resolution resume per conflict
 * episode. `UNKNOWN` (GitHub hasn't computed mergeability yet) is treated as
 * "not conflicting, check again next cycle" rather than triggering a resume.
 */
export function shouldResumeForConflict(mergeable: PrMergeable, conflictHandled: boolean | undefined): boolean {
  return mergeable === "CONFLICTING" && !conflictHandled;
}

/** Once a previously-conflicted PR reports MERGEABLE again, a later conflict is a new episode and eligible again. */
export function shouldClearConflictGuard(mergeable: PrMergeable, conflictHandled: boolean | undefined): boolean {
  return mergeable === "MERGEABLE" && !!conflictHandled;
}

/**
 * Changes-requested reviews (or fresh inline comments), and/or a CONFLICTING
 * mergeable state, on an open fleet PR resume that ticket's session in its
 * existing worktree/branch — one combined resume when both apply. Runs before
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
    // Best-effort: several GitHub calls happen below before this candidate
    // could reach `track()`, so this can't be perfectly race-free the way the
    // no-further-awaits checks in `claim.ts`/`recovery.ts` are — but it stops
    // the common case early, and `stopLiveSessions`'s sweep catches whatever
    // slips through this window regardless.
    if (ctx.isShuttingDown()) return;

    const scope = key(project.name, record.issueNumber);

    let mergeable: PrMergeable = "UNKNOWN";
    try {
      mergeable = await getPrMergeable(project, record.prUrl as string);
    } catch (err) {
      logError("loop", `${scope}: could not fetch PR mergeable state`, err);
    }
    if (shouldClearConflictGuard(mergeable, record.conflictHandled)) {
      ctx.state.update(project.name, record.issueNumber, { conflictHandled: false });
    }
    const isConflicting = shouldResumeForConflict(mergeable, record.conflictHandled);

    let feedback: PrFeedback | undefined;
    try {
      feedback = await getPrFeedback(project, record.prUrl as string, record.lastReviewHandledAt);
    } catch (err) {
      logError("loop", `${scope}: could not fetch PR review feedback`, err);
    }
    const hasFeedback = !!feedback && shouldActOnFeedback(feedback) && !!feedback.latestAt;

    if (!hasFeedback && !isConflicting) continue;

    const prompt = [
      hasFeedback ? buildReviewFeedbackPrompt(feedback as PrFeedback) : undefined,
      isConflicting ? buildConflictPrompt(project.defaultBranch) : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n\n---\n\n");

    // Watermarks set before resuming so a crash can't reprocess the same feedback/conflict.
    if (hasFeedback) ctx.state.update(project.name, record.issueNumber, { lastReviewHandledAt: (feedback as PrFeedback).latestAt });
    if (isConflicting) ctx.state.update(project.name, record.issueNumber, { conflictHandled: true });

    await swapLabel(project, record.issueNumber, FLEET_LABELS.review, FLEET_LABELS.inProgress);
    const reason = hasFeedback && isConflicting
      ? "PR review feedback and a merge conflict arrived"
      : isConflicting
        ? "PR reports a merge conflict"
        : "PR review feedback arrived";
    log("loop", `${scope}: ${reason} — resuming session ${record.sessionId}`);
    track(ctx, project.name, record.issueNumber, resumeTicket(ctx, project, record, prompt));
  }
}
