import {
  ALL_FLEET_LABELS,
  FLEET_LABELS,
  PLAN_LABEL,
  PRIORITY_LABELS,
  boardStatusFromLabels,
  priorityOf,
  type BoardTicket,
  type ProjectConfig,
} from "@fleet/shared";
import { run, runJson } from "./exec.ts";

const STATUS_MARKER = "<!-- fleet-status -->";

export interface ReadyIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface FleetIssue extends ReadyIssue {
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

export async function swapLabel(project: ProjectConfig, issueNumber: number, from: string, to: string): Promise<void> {
  await run("gh", [
    "issue", "edit", String(issueNumber),
    "--repo", project.githubRepo,
    "--remove-label", from,
    "--add-label", to,
  ]);
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
}
