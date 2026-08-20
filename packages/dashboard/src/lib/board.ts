import { BOARD_COLUMNS, type BoardStatus, type BoardTicket } from "@fleet/shared";

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
