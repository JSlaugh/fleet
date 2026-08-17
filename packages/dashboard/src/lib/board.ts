import type { BoardTicket } from "@fleet/shared";

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
