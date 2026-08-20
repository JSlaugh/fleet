import { BOARD_COLUMNS, type BoardStatus, type BoardTicket, type PendingApproval } from "@fleet/shared";

/**
 * Clusters tickets sharing an epic together, preserving each cluster's
 * first-appearance position — the "modest" half of epic↔child board grouping
 * (no drag/drop, just adjacency). A child buckets under its `epicNumber`; the
 * epic ticket itself carries no `epicNumber` (it isn't `Part-of` anything),
 * so it's keyed by its own issue number instead — which is exactly the
 * number its children's `epicNumber` points at — so it joins their bucket
 * rather than sitting alone.
 */
export function groupByEpic(list: BoardTicket[]): BoardTicket[] {
  const buckets = new Map<string, BoardTicket[]>();
  for (const ticket of list) {
    const epicIssueNumber = ticket.epicNumber ?? (ticket.epicProgress ? ticket.issueNumber : undefined);
    const bucketKey = epicIssueNumber !== undefined ? `epic:${ticket.project}#${epicIssueNumber}` : `solo:${ticket.project}#${ticket.issueNumber}`;
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.push(ticket);
    else buckets.set(bucketKey, [ticket]);
  }
  return [...buckets.values()].flat();
}

/** One dormant project's rollup row (#152): per-column counts plus whether it needs an operator's attention. */
export interface ProjectRollup {
  project: string;
  counts: Record<BoardStatus, number>;
  needsAttention: boolean;
}

/**
 * Summarizes a dormant project's tickets for its collapsed rollup row.
 * `pendingApprovals` comes from the separate approvals feed (keyed by
 * `project#issue`, not carried on `BoardTicket`), so it's passed in rather
 * than derived from `tickets` here. A ticket's transient `record.status ===
 * "failed"` (mid-retry, before the daemon relabels it `fleet:needs-input`)
 * counts toward attention too, since it'd otherwise be invisible while collapsed.
 */
export function projectRollup(project: string, tickets: BoardTicket[], pendingApprovals: number): ProjectRollup {
  const counts = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.status, 0])) as Record<BoardStatus, number>;
  let needsAttention = pendingApprovals > 0;
  for (const ticket of tickets) {
    if (ticket.project !== project) continue;
    counts[ticket.status] += 1;
    if (ticket.status === "needs-input") needsAttention = true;
    if (ticket.record?.status === "failed") needsAttention = true;
  }
  return { project, counts, needsAttention };
}

/** One row in the cross-project "needs me" queue (#161) — see `buildAttentionQueue`. */
export type AttentionKind = "approval" | "needs-input" | "failed" | "review";

export interface AttentionItem {
  kind: AttentionKind;
  project: string;
  issueNumber: number;
  title: string;
  detail: string;
  /** GitHub issue URL, for the row's external "view issue" link. */
  url: string;
  /** GitHub PR URL, present only on a `review` item that has an open PR. */
  prUrl?: string;
  /** Set only on `approval` items — the id `resolveApproval`/the approvals panel key on. */
  approvalId?: string;
  since: string;
  waitMs: number;
}

/**
 * Builds the cross-project attention queue: parked approvals, `needs-input`
 * questions, failed tickets (still labeled `fleet:needs-input` on GitHub, but
 * distinguished here by `record.status === "failed"` — see `TicketCard`'s own
 * "failed" badge for the same distinction), and `review`-column tickets
 * awaiting a human (a PR to review, or a plan epic to curate). Deliberately
 * takes the *unfiltered* ticket/approval lists — dormant projects' items
 * belong in this queue too (#152 collapses them out of the board columns, not
 * out of what needs a human).
 *
 * Sourced from `record.lastActivityAt`, the same "when did this happen"
 * timestamp `computeDigest` keys its blocked/failed/review buckets off of.
 * It's stamped when the ticket's last work turn *started* (`markWorking`),
 * not when it actually entered the waiting state, so a long-running turn
 * inflates the reported wait slightly — the closest available proxy without
 * a daemon-side timestamp dedicated to state entry.
 */
export function buildAttentionQueue(tickets: BoardTicket[], approvals: PendingApproval[], now: number): AttentionItem[] {
  const byTicket = new Map(tickets.map((t) => [`${t.project}#${t.issueNumber}`, t]));
  const items: AttentionItem[] = [];

  for (const approval of approvals) {
    const ticket = byTicket.get(`${approval.project}#${approval.issueNumber}`);
    items.push({
      kind: "approval",
      project: approval.project,
      issueNumber: approval.issueNumber,
      title: ticket?.title ?? `${approval.project}#${approval.issueNumber}`,
      detail: approval.kind === "question" ? "Question from the worker" : `Approval needed: ${approval.toolName}`,
      url: ticket?.url ?? "",
      approvalId: approval.id,
      since: approval.createdAt,
      waitMs: now - Date.parse(approval.createdAt),
    });
  }

  for (const ticket of tickets) {
    if (ticket.status !== "needs-input" && ticket.status !== "review") continue;
    const since = ticket.record?.lastActivityAt;
    if (!since) continue;
    const failed = ticket.record?.status === "failed";
    const prUrl = ticket.status === "review" ? ticket.record?.prUrl : undefined;
    const kind: AttentionKind = ticket.status === "review" ? "review" : failed ? "failed" : "needs-input";
    items.push({
      kind,
      project: ticket.project,
      issueNumber: ticket.issueNumber,
      title: ticket.title,
      detail:
        kind === "review"
          ? prUrl
            ? "PR awaiting review"
            : "Plan awaiting curation"
          : (ticket.record?.lastSummary ?? (kind === "failed" ? "Run failed" : "Needs input")),
      url: ticket.url,
      prUrl,
      since,
      waitMs: now - Date.parse(since),
    });
  }

  return items.sort((a, b) => b.waitMs - a.waitMs);
}
