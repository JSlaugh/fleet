import {
  ALL_FLEET_LABELS,
  ELEVATE_LABEL,
  FLEET_LABELS,
  PLAN_LABEL,
  PRIORITY_LABELS,
  boardStatusFromLabels,
  priorityOf,
  profileNames,
  typeLabel,
  type BoardTicket,
  type ProjectConfig,
} from "@fleet/shared";
import { readBuildSpec } from "./buildspec.ts";
import { run, runJson } from "./exec.ts";
import { log, logError } from "../log.ts";

const STATUS_MARKER = "<!-- fleet-status -->";

export interface ReadyIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

interface FleetIssue extends ReadyIssue {
  url: string;
}

interface GhIssueJson {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  url: string;
}

interface RestComment {
  id: number;
  body: string;
  user: { login: string };
}

function listComments(project: ProjectConfig, issueNumber: number): Promise<RestComment[]> {
  return runJson<RestComment[]>("gh", ["api", `repos/${project.githubRepo}/issues/${issueNumber}/comments`]);
}

export function priorityRank(labels: string[]): number {
  const index = PRIORITY_LABELS.findIndex((p) => labels.includes(p));
  return index === -1 ? PRIORITY_LABELS.length : index;
}

export async function listFleetIssues(project: ProjectConfig): Promise<FleetIssue[]> {
  const issues = await runJson<GhIssueJson[]>("gh", [
    "issue", "list",
    "--repo", project.githubRepo,
    "--state", "open",
    "--json", "number,title,body,labels,url",
    "--limit", "100",
  ]);
  return issues
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((l) => l.name),
      url: issue.url,
    }))
    .filter((issue) => issue.labels.some((l) => l.startsWith("fleet:")))
    .sort((a, b) => priorityRank(a.labels) - priorityRank(b.labels) || a.number - b.number);
}

export function toBoardTicket(project: ProjectConfig, issue: FleetIssue, blockedBy: number[] = []): BoardTicket | null {
  const status = boardStatusFromLabels(issue.labels);
  if (!status) return null;
  return {
    project: project.name,
    issueNumber: issue.number,
    title: issue.title,
    url: issue.url,
    status,
    priority: priorityOf(issue.labels),
    isPlan: issue.labels.includes(PLAN_LABEL),
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
  };
}

/**
 * Reads a `Depends-on: #12, #14` line anywhere in the issue body (case-insensitive
 * key, `#`-prefixed numbers, comma/space separated). Entries that aren't a bare
 * `#<digits>` token are ignored rather than rejecting the whole line, so a stray
 * typo in the list doesn't drop every other dependency.
 */
export function parseDependsOn(body: string): number[] {
  const match = /^\s*depends-on\s*:\s*(.+)$/im.exec(body);
  if (!match) return [];
  const numbers = (match[1] ?? "")
    .split(/[\s,]+/)
    .map((token) => /^#(\d+)$/.exec(token.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1] ?? ""))
    .filter((n) => !Number.isNaN(n));
  return [...new Set(numbers)];
}

/**
 * `blockedBy` is deps that are still open (unsatisfied); `unknown` is deps that
 * reference an issue number this repo has never had — treated as satisfied so a
 * typo can't wedge a ticket forever, but worth logging so it can be fixed.
 */
export function dependencyStatus(
  deps: number[],
  openIssueNumbers: ReadonlySet<number>,
  allIssueNumbers: ReadonlySet<number>,
): { blockedBy: number[]; unknown: number[] } {
  return {
    blockedBy: deps.filter((n) => openIssueNumbers.has(n)),
    unknown: deps.filter((n) => !allIssueNumbers.has(n)),
  };
}

interface GhIssueStateJson {
  number: number;
  state: string;
}

/**
 * Every open *and* closed issue number in the repo, unfiltered by label — a
 * dependency may reference an issue that never carried a `fleet:*` label.
 * `all` also covers closed issues so a nonexistent dep number can be told apart
 * from a legitimately closed one.
 */
export async function listIssueStates(project: ProjectConfig): Promise<{ open: Set<number>; all: Set<number> }> {
  const issues = await runJson<GhIssueStateJson[]>("gh", [
    "issue", "list",
    "--repo", project.githubRepo,
    "--state", "all",
    "--json", "number,state",
    "--limit", "500",
  ]);
  return {
    open: new Set(issues.filter((i) => i.state === "OPEN").map((i) => i.number)),
    all: new Set(issues.map((i) => i.number)),
  };
}

/**
 * `gh issue create` prints the new issue's URL on stdout (after any hint lines),
 * and the number is its last path segment.
 */
export function issueNumberFromUrl(url: string): number {
  const number = Number(url.trim().split("/").pop());
  if (!Number.isInteger(number) || number <= 0) throw new Error(`could not parse an issue number from ${url.trim()}`);
  return number;
}

export async function createIssue(
  project: ProjectConfig,
  opts: { title: string; body: string; labels: string[] },
): Promise<{ number: number; url: string }> {
  const args = [
    "issue", "create",
    "--repo", project.githubRepo,
    "--title", opts.title,
    "--body", opts.body,
  ];
  for (const label of opts.labels) args.push("--label", label);
  const { stdout } = await run("gh", args);
  const url = stdout.trim().split("\n").pop()?.trim() ?? "";
  return { number: issueNumberFromUrl(url), url };
}

export async function setPriority(project: ProjectConfig, issueNumber: number, priority: string | null): Promise<void> {
  const args = ["issue", "edit", String(issueNumber), "--repo", project.githubRepo];
  for (const label of PRIORITY_LABELS) {
    if (label !== priority) args.push("--remove-label", label);
  }
  if (priority) args.push("--add-label", priority);
  await run("gh", args);
}

export async function getIssueComments(project: ProjectConfig, issueNumber: number): Promise<string[]> {
  const comments = await listComments(project, issueNumber);
  return comments
    .filter((c) => !c.body.startsWith(STATUS_MARKER))
    .map((c) => `@${c.user.login}: ${c.body}`);
}

/**
 * Error policy: a label swap gates the state machine — the next poll cycle
 * decides what to do with a ticket by reading its label — so a failed swap
 * genuinely changes what should happen next. Callers let it throw rather than
 * swallow it into a ticket whose label and recorded status disagree.
 */
export async function swapLabel(project: ProjectConfig, issueNumber: number, from: string, to: string): Promise<void> {
  await run("gh", [
    "issue", "edit", String(issueNumber),
    "--repo", project.githubRepo,
    "--remove-label", from,
    "--add-label", to,
  ]);
}

/**
 * Move an issue from in-progress back to ready, tagged `fleet:elevate`, so the
 * next poll cycle re-claims it on the project's elevated model. Used for the
 * once-only auto-escalation retry after a non-elevated run fails.
 */
export function escalateLabelArgs(project: ProjectConfig, issueNumber: number): string[] {
  return [
    "issue", "edit", String(issueNumber),
    "--repo", project.githubRepo,
    "--remove-label", FLEET_LABELS.inProgress,
    "--add-label", ELEVATE_LABEL,
    "--add-label", FLEET_LABELS.ready,
  ];
}

export async function escalateToElevated(project: ProjectConfig, issueNumber: number): Promise<void> {
  await run("gh", escalateLabelArgs(project, issueNumber));
}

/**
 * Whatever fleet state label the issue currently carries, drop it and add
 * `fleet:ready`. Removing a label the issue does not have is a no-op for `gh`
 * (the labels themselves exist in the repo — `init-labels` creates them), which
 * is what lets an operator restart work from any state without reading the
 * issue's labels first.
 */
export function readyLabelArgs(project: ProjectConfig, issueNumber: number): string[] {
  const args = ["issue", "edit", String(issueNumber), "--repo", project.githubRepo];
  for (const label of [FLEET_LABELS.inProgress, FLEET_LABELS.needsInput, FLEET_LABELS.review]) {
    args.push("--remove-label", label);
  }
  args.push("--add-label", FLEET_LABELS.ready);
  return args;
}

export async function markReady(project: ProjectConfig, issueNumber: number): Promise<void> {
  await run("gh", readyLabelArgs(project, issueNumber));
}

/**
 * Error policy: the status comment only mirrors ticket state for humans on
 * GitHub — labels (via `swapLabel`) remain the source of truth the daemon
 * itself acts on. Callers treat a failure here as best-effort: log it and
 * continue, rather than letting a transient `gh` failure while posting a
 * comment escalate into a ticket reported as failed even though the actual
 * work succeeded.
 */
export async function upsertStatusComment(project: ProjectConfig, issueNumber: number, body: string): Promise<void> {
  const full = `${STATUS_MARKER}\n${body}`;
  const existing = (await listComments(project, issueNumber)).find((c) => c.body.startsWith(STATUS_MARKER));
  if (existing) {
    await run("gh", [
      "api", `repos/${project.githubRepo}/issues/comments/${existing.id}`,
      "-X", "PATCH", "-f", `body=${full}`,
    ]);
  } else {
    await run("gh", [
      "issue", "comment", String(issueNumber),
      "--repo", project.githubRepo,
      "--body", full,
    ]);
  }
}

export async function createPullRequest(
  project: ProjectConfig,
  branch: string,
  title: string,
  body: string,
): Promise<string> {
  const { stdout } = await run("gh", [
    "pr", "create",
    "--repo", project.githubRepo,
    "--head", branch,
    "--base", project.defaultBranch,
    "--title", title,
    "--body", body,
  ]);
  return stdout.trim().split("\n").pop()?.trim() ?? "";
}

export async function getIssueLabels(project: ProjectConfig, issueNumber: number): Promise<string[]> {
  const { labels } = await runJson<{ labels: { name: string }[] }>("gh", [
    "issue", "view", String(issueNumber),
    "--repo", project.githubRepo,
    "--json", "labels",
  ]);
  return labels.map((l) => l.name);
}

export async function getPrState(project: ProjectConfig, prUrl: string): Promise<string> {
  const { state } = await runJson<{ state: string }>("gh", [
    "pr", "view", prUrl,
    "--repo", project.githubRepo,
    "--json", "state",
  ]);
  return state;
}

export type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/**
 * GitHub computes mergeability lazily, so `UNKNOWN` is a legitimate, common
 * answer (not an error) — callers treat it as "not conflicting, check again
 * next cycle" rather than retrying immediately.
 */
export async function getPrMergeable(project: ProjectConfig, prUrl: string): Promise<PrMergeable> {
  const { mergeable } = await runJson<{ mergeable: string }>("gh", [
    "pr", "view", prUrl,
    "--repo", project.githubRepo,
    "--json", "mergeable",
  ]);
  return mergeable === "MERGEABLE" || mergeable === "CONFLICTING" ? mergeable : "UNKNOWN";
}

interface GhReview {
  user: { login: string } | null;
  state: string;
  body: string | null;
  submitted_at: string;
}

interface GhReviewComment {
  path: string;
  line: number | null;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
}

interface PrReview {
  author: string;
  state: string;
  body: string;
  submittedAt: string;
}

interface PrComment {
  path: string;
  line: number | null;
  body: string;
  author: string;
  createdAt: string;
}

export interface PrFeedback {
  reviews: PrReview[];
  comments: PrComment[];
  hasChangesRequested: boolean;
  latestAt: string | undefined;
}

function isNewerThan(ts: string, since: string | undefined): boolean {
  return since === undefined || Date.parse(ts) > Date.parse(since);
}

function hasMeaningfulBody(body: string | null): body is string {
  return !!body && body.trim().length > 0 && !body.startsWith(STATUS_MARKER);
}

/**
 * `hasChangesRequested` looks at every new review regardless of body — a bare
 * "Changes requested" with no comment is still a real signal to act on. The
 * `reviews`/`comments` arrays drop empty bodies and the fleet status marker so
 * a feedback prompt built from them never quotes noise. `latestAt` covers every
 * new item (not just the filtered ones) so the watermark can't get stuck behind
 * something that was filtered out of the arrays.
 */
export function buildPrFeedback(
  rawReviews: GhReview[],
  rawComments: GhReviewComment[],
  since: string | undefined,
): PrFeedback {
  const newReviews = rawReviews.filter((r) => isNewerThan(r.submitted_at, since));
  const newComments = rawComments.filter((c) => isNewerThan(c.created_at, since));

  const hasChangesRequested = newReviews.some((r) => r.state === "CHANGES_REQUESTED");

  const reviews = newReviews
    .filter((r) => hasMeaningfulBody(r.body))
    .map((r) => ({ author: r.user?.login ?? "unknown", state: r.state, body: r.body as string, submittedAt: r.submitted_at }));

  const comments = newComments
    .filter((c) => hasMeaningfulBody(c.body))
    .map((c) => ({ path: c.path, line: c.line, body: c.body as string, author: c.user?.login ?? "unknown", createdAt: c.created_at }));

  const timestamps = [...newReviews.map((r) => r.submitted_at), ...newComments.map((c) => c.created_at)];
  const latestAt = timestamps.length > 0
    ? timestamps.reduce((latest, ts) => (Date.parse(ts) > Date.parse(latest) ? ts : latest))
    : undefined;

  return { reviews, comments, hasChangesRequested, latestAt };
}

/** Reviews and inline comments newer than `since` (undefined = everything) on a fleet PR. */
export async function getPrFeedback(
  project: ProjectConfig,
  prUrl: string,
  since: string | undefined,
): Promise<PrFeedback> {
  const prNumber = issueNumberFromUrl(prUrl);
  const [rawReviews, rawComments] = await Promise.all([
    runJson<GhReview[]>("gh", ["api", `repos/${project.githubRepo}/pulls/${prNumber}/reviews`]),
    runJson<GhReviewComment[]>("gh", ["api", `repos/${project.githubRepo}/pulls/${prNumber}/comments`]),
  ]);
  return buildPrFeedback(rawReviews, rawComments, since);
}

/** Review bodies first, then inline comments grouped by `path:line`. */
export function buildReviewFeedbackPrompt(feedback: { reviews: PrReview[]; comments: PrComment[] }): string {
  const parts: string[] = ["New feedback arrived on this ticket's PR."];

  if (feedback.reviews.length > 0) {
    parts.push(
      `## Review comments\n\n${feedback.reviews.map((r) => `**@${r.author}** (${r.state}):\n${r.body}`).join("\n\n")}`,
    );
  }

  if (feedback.comments.length > 0) {
    const grouped = new Map<string, PrComment[]>();
    for (const comment of feedback.comments) {
      const key = `${comment.path}:${comment.line ?? "?"}`;
      grouped.set(key, [...(grouped.get(key) ?? []), comment]);
    }
    const sections = [...grouped.entries()].map(
      ([key, comments]) => `**${key}**\n${comments.map((c) => `@${c.author}: ${c.body}`).join("\n")}`,
    );
    parts.push(`## Inline comments\n\n${sections.join("\n\n")}`);
  }

  parts.push("Address each point, commit your changes, and finish with an updated structured result. The PR updates automatically when you complete.");
  return parts.join("\n\n");
}

/** Appended when the PR reports CONFLICTING — a sibling PR merged underneath this branch. */
export function buildConflictPrompt(defaultBranch: string): string {
  return [
    `## Merge conflict`,
    `This ticket's PR now conflicts with \`${defaultBranch}\` — another PR merged underneath it. Merge \`origin/${defaultBranch}\` into this branch, resolve the conflicts preserving both sides' intent, re-run the project's checks, and finish with an updated structured result. The PR updates automatically when you complete.`,
  ].join("\n\n");
}

export async function closeIssue(project: ProjectConfig, issueNumber: number): Promise<void> {
  await run("gh", ["issue", "close", String(issueNumber), "--repo", project.githubRepo]);
}

export async function ensureLabels(project: ProjectConfig): Promise<void> {
  for (const label of ALL_FLEET_LABELS) {
    await run("gh", [
      "label", "create", label.name,
      "--repo", project.githubRepo,
      "--color", label.color,
      "--description", label.description,
      "--force",
    ]);
  }

  // Type labels are per-repo (driven by that repo's own fleet.yaml), so they
  // never join ALL_FLEET_LABELS — reading the main checkout after a fetch is
  // acceptable here since init-labels is a one-off command, not the claim path.
  await run("git", ["-C", project.repoPath, "fetch", "origin", project.defaultBranch], { allowFailure: true });
  let spec;
  try {
    spec = readBuildSpec(project.repoPath);
  } catch (err) {
    logError("labels", `${project.name}: fleet.yaml is invalid — skipping type-label creation`, err);
    return;
  }
  if (!spec) return;

  for (const name of profileNames(spec)) {
    log("labels", `${project.name}: creating type label for fleet.yaml profile "${name}"`);
    await run("gh", [
      "label", "create", typeLabel(name),
      "--repo", project.githubRepo,
      "--color", "c5def5",
      "--description", `Route this ticket to the "${name}" fleet.yaml setup profile`,
      "--force",
    ]);
  }
}
