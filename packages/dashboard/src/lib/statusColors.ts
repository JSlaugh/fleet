import type { BoardStatus } from "@fleet/shared";

// Single home for status → token-based class mappings. Every color here rides
// the semantic tokens in style.css, so light/dark both come from one place.

/** Solid accent dot/bar per board column. */
export const STATUS_ACCENTS: Record<BoardStatus, string> = {
  ready: "bg-success",
  "in-progress": "bg-warning",
  "needs-input": "bg-destructive",
  review: "bg-info",
  done: "bg-muted-foreground",
};

/** Soft badge classes per machine/plan review outcome. */
export function machineReviewBadgeClass(outcome: string): string {
  switch (outcome) {
    case "findings":
      return "bg-warning/15 text-warning";
    case "passed":
      return "bg-success/15 text-success";
    case "error":
      return "bg-destructive/15 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/** Pill classes for the rolling spend budget gate. */
export function budgetGateClass(gate: string | undefined): string {
  switch (gate) {
    case "blocked":
      return "bg-destructive/15 text-destructive";
    case "light-only":
      return "bg-warning/15 text-warning";
    default:
      return "text-muted-foreground";
  }
}
