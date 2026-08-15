import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { key, type LoopContext } from "./context.ts";
import {
  getAuthenticatedLogin,
  getPrChecks,
  getPrMergeable,
  getPrReviews,
  mergePullRequest,
  upsertStatusComment,
  type PrCheck,
  type PrMergeable,
  type PrApprovalReview as PrReview,
} from "../github/github.ts";
import { log, logError } from "../log.ts";

/**
 * Ticket records eligible for auto-merge evaluation this cycle: sitting in
 * `review` with a PR, not already in flight, their issue still open, and the
 * project has opted in.
 */
export function pickAutoMergeCandidates(
  records: TicketRecord[],
  project: { name: string; autoMerge?: boolean },
  openIssueNumbers: ReadonlySet<number>,
  runningKeys: Iterable<string>,
): TicketRecord[] {
  if (!project.autoMerge) return [];
  const running = new Set(runningKeys);
  return records.filter(
    (record) =>
      record.project === project.name &&
      record.status === "review" &&
      !!record.prUrl &&
      openIssueNumbers.has(record.issueNumber) &&
      !running.has(key(record.project, record.issueNumber)),
  );
}

/** The most recent review per author (case-insensitive login) — an earlier review from the same person no longer counts. */
export function latestReviewByAuthor(reviews: PrReview[]): Map<string, PrReview> {
  const latest = new Map<string, PrReview>();
  for (const review of reviews) {
    const login = review.author.toLowerCase();
    const existing = latest.get(login);
    if (!existing || Date.parse(review.submittedAt) >= Date.parse(existing.submittedAt)) {
      latest.set(login, review);
    }
  }
  return latest;
}

/**
 * Approved by at least one allowlisted login, with no outstanding
 * changes-requested review from anyone. An approver who later requested
 * changes no longer counts as an approval; a non-approver's outstanding
 * changes-requested still blocks regardless of who else approved.
 */
export function isApprovedForMerge(reviews: PrReview[], approvers: string[]): boolean {
  const latest = [...latestReviewByAuthor(reviews).values()];
  if (latest.some((r) => r.state === "CHANGES_REQUESTED")) return false;
  const allowlist = new Set(approvers.map((a) => a.toLowerCase()));
  return latest.some((r) => r.state === "APPROVED" && allowlist.has(r.author.toLowerCase()));
}

/** Every reported check has passed; a PR with zero checks reported counts as green. */
export function checksAreGreen(checks: PrCheck[]): boolean {
  return checks.every((c) => c.bucket === "pass" || c.bucket === "skipping");
}

export function isMergeReady(input: {
  reviews: PrReview[];
  approvers: string[];
  checks: PrCheck[];
  mergeable: PrMergeable;
}): boolean {
  return (
    isApprovedForMerge(input.reviews, input.approvers) &&
    checksAreGreen(input.checks) &&
    input.mergeable === "MERGEABLE"
  );
}

/**
 * Merges every auto-merge candidate that's approved by an allowlisted login,
 * green on CI, and mergeable. Runs after `addressReviews` in the same cycle
 * pass so a PR with actionable feedback gets resumed, not merged. A fetch or
 * merge failure for one candidate is logged and left for the next cycle
 * rather than failing the ticket — merging is a best-effort convenience on
 * top of a ticket that already succeeded.
 */
export async function autoMergeReady(
  ctx: LoopContext,
  project: ProjectConfig,
  openIssueNumbers: ReadonlySet<number>,
): Promise<void> {
  const candidates = pickAutoMergeCandidates(ctx.state.all(), project, openIssueNumbers, ctx.running.keys());
  if (candidates.length === 0) return;

  const approvers = project.approvers && project.approvers.length > 0 ? project.approvers : [await getAuthenticatedLogin()];

  for (const record of candidates) {
    if (ctx.isShuttingDown()) return;

    const scope = key(project.name, record.issueNumber);
    const prUrl = record.prUrl as string;

    let reviews: PrReview[];
    let checks: PrCheck[];
    let mergeable: PrMergeable;
    try {
      [reviews, checks, mergeable] = await Promise.all([
        getPrReviews(project, prUrl),
        getPrChecks(project, prUrl),
        getPrMergeable(project, prUrl),
      ]);
    } catch (err) {
      logError("loop", `${scope}: could not fetch PR state for auto-merge`, err);
      continue;
    }

    if (!isMergeReady({ reviews, approvers, checks, mergeable })) continue;

    const approver = [...latestReviewByAuthor(reviews).values()].find(
      (r) => r.state === "APPROVED" && approvers.some((a) => a.toLowerCase() === r.author.toLowerCase()),
    );

    try {
      await mergePullRequest(project, prUrl, project.mergeMethod ?? "squash");
    } catch (err) {
      logError("loop", `${scope}: auto-merge failed — will retry next cycle`, err);
      continue;
    }

    try {
      await upsertStatusComment(
        project,
        record.issueNumber,
        `**Status: merged** — merged automatically (approved by @${approver?.author ?? "unknown"}, checks green)`,
      );
    } catch (err) {
      logError("loop", `${scope}: could not post the merged status comment`, err);
    }
    log("loop", `${scope}: auto-merged ${prUrl} (${project.mergeMethod ?? "squash"})`);
  }
}
