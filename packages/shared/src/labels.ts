import type { BoardStatus } from "./board.ts";

export const FLEET_LABELS = {
  ready: "fleet:ready",
  inProgress: "fleet:in-progress",
  needsInput: "fleet:needs-input",
  review: "fleet:review",
  /** Filed and visible on the board, but not yet released for pickup — plan children land here until the plan is accepted. */
  backlog: "fleet:backlog",
} as const;

export const PRIORITY_LABELS = ["fleet:p1", "fleet:p2", "fleet:p3"] as const;

export const ELEVATE_LABEL = "fleet:elevate";

export const LIGHT_LABEL = "fleet:light";

export const PLAN_LABEL = "fleet:plan";

/** Prefix for the per-repo, fleet.yaml-declared setup-profile labels — never added to `ALL_FLEET_LABELS` since these are per-repo, not global. */
export const FLEET_TYPE_LABEL_PREFIX = "fleet:type:";

export function typeLabel(name: string): string {
  return `${FLEET_TYPE_LABEL_PREFIX}${name}`;
}

/** The `<name>` part of a ticket's `fleet:type:<name>` label, or null if it has none. */
export function typeOf(labels: string[]): string | null {
  const label = labels.find((l) => l.startsWith(FLEET_TYPE_LABEL_PREFIX));
  return label ? label.slice(FLEET_TYPE_LABEL_PREFIX.length) : null;
}

export const ALL_FLEET_LABELS: { name: string; color: string; description: string }[] = [
  { name: FLEET_LABELS.ready, color: "0e8a16", description: "Eligible for pickup by a fleet worker" },
  { name: FLEET_LABELS.inProgress, color: "fbca04", description: "A fleet worker session is on it" },
  { name: FLEET_LABELS.needsInput, color: "d93f0b", description: "Worker is blocked on a human decision" },
  { name: FLEET_LABELS.review, color: "1d76db", description: "PR open, awaiting human review" },
  { name: FLEET_LABELS.backlog, color: "c5def5", description: "Filed but not yet released — mark fleet:ready to start it" },
  { name: ELEVATE_LABEL, color: "5319e7", description: "Run this ticket on the project's elevated model" },
  { name: LIGHT_LABEL, color: "bfd4f2", description: "Run this ticket on the project's light model" },
  { name: PLAN_LABEL, color: "c2e0c6", description: "Decompose this epic into child tickets instead of coding it" },
  { name: "fleet:p1", color: "b60205", description: "Highest priority" },
  { name: "fleet:p2", color: "d93f0b", description: "Medium priority" },
  { name: "fleet:p3", color: "fef2c0", description: "Low priority" },
];

export function boardStatusFromLabels(labels: string[]): BoardStatus | null {
  if (labels.includes(FLEET_LABELS.ready)) return "ready";
  if (labels.includes(FLEET_LABELS.inProgress)) return "in-progress";
  if (labels.includes(FLEET_LABELS.needsInput)) return "needs-input";
  if (labels.includes(FLEET_LABELS.review)) return "review";
  if (labels.includes(FLEET_LABELS.backlog)) return "backlog";
  return null;
}

export function priorityOf(labels: string[]): string | null {
  return PRIORITY_LABELS.find((p) => labels.includes(p)) ?? null;
}
