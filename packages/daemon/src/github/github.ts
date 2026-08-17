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
const HEARTBEAT_LINE_REGEX = /^<!--\s*fleet-heartbeat:\s*(\S+)\s+owner:\s*(\S+)\s*-->$/m;

export interface ReadyIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** Issue-opener's login — the contributor-floor check filters claims on this. Empty for synthetic issues built for a resume, where the original author isn't tracked. */
  author: string;
  /**
   * Current issue assignees, for the claim routing rule (unassigned or
   * assigned-to-me is claimable; assigned to anyone else is not). Undefined
   * for synthetic issues built for a resume, where callers treat it the same
   * as empty rather than needing every call site to populate it.
   */
  assignees?: string[];
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
  author: { login: string };
  assignees: { login: string }[];
}

interface RestComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
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
    "--json", "number,title,body,labels,url,author,assignees",
    "--limit", "100",
  ]);
  return issues
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((l) => l.name),
      url: issue.url,
      author: issue.author?.login ?? "",
      assignees: issue.assignees.map((a) => a.login),
    }))
    .filter((issue) => issue.labels.some((l) => l.startsWith("fleet:")))
    .sort((a, b) => priorityRank(a.labels) - priorityRank(b.labels) || a.number - b.number);
}

export function toBoardTicket(project: ProjectConfig, issue: FleetIssue, blockedBy: number[] = []): BoardTicket | null {
  const status = boardStatusFromLabels(issue.labels);
  if (!status) return null;
  const epicNumber = parsePartOf(issue.body);
  const children = parseChildTaskList(issue.body);
  return {
    project: project.name,
    issueNumber: issue.number,
    title: issue.title,
    url: issue.url,
    status,
    priority: priorityOf(issue.labels),
    isPlan: issue.labels.includes(PLAN_LABEL),
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
    ...(epicNumber !== undefined ? { epicNumber } : {}),
    ...(children.length > 0 ? { epicProgress: { closed: children.filter((c) => c.checked).length, total: children.length } } : {}),
  };
}

/**
 * Reads dependencies from two possible spots in an issue body, unioning both: a
 * `Depends-on: #12, #14` line typed anywhere (case-insensitive key, comma/space
 * separated), and the `### Depends on\n\n#12 #14` section GitHub renders for the
 * `depends-on` field of the fleet-task issue form. Entries that aren't a bare
 * `#<digits>` token are ignored rather than rejecting the whole match, so a stray
 * typo in the list doesn't drop every other dependency.
 */
export function parseDependsOn(body: string): number[] {
  const lineMatch = /^\s*depends-on\s*:\s*(.+)$/im.exec(body);
  const sectionMatch = /^###\s*depends on\s*\r?\n+([^\n]*)/im.exec(body);
  const raw = [lineMatch?.[1], sectionMatch?.[1]].filter((s): s is string => s !== undefined).join(" ");
  const numbers = raw
    .split(/[\s,]+/)
    .map((token) => /^#(\d+)$/.exec(token.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1] ?? ""))
    .filter((n) => !Number.isNaN(n));
  return [...new Set(numbers)];
}

/** Appends a `Depends-on: #...` line `parseDependsOn` will parse back out. */
export function bodyWithDependsOn(body: string, dependsOn: number[] | undefined): string {
  if (!dependsOn || dependsOn.length === 0) return body;
  const line = `Depends-on: ${dependsOn.map((n) => `#${n}`).join(", ")}`;
  return body.trim().length > 0 ? `${body}\n\n${line}` : line;
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

/**
 * Reads the epic an issue was filed under from a `Part-of: #12` line typed
 * anywhere in the body (case-insensitive key) — the child-side counterpart to
 * `parseDependsOn`. Only the first reference counts; a ticket has at most one
 * epic.
 */
export function parsePartOf(body: string): number | undefined {
  const match = /^\s*part-of\s*:\s*#(\d+)/im.exec(body);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isNaN(n) ? undefined : n;
}

/** Appends a `Part-of: #<epic>` line `parsePartOf` will parse back out. */
export function bodyWithPartOf(body: string, epicNumber: number | undefined): string {
  if (epicNumber === undefined) return body;
  const line = `Part-of: #${epicNumber}`;
  return body.trim().length > 0 ? `${body}\n\n${line}` : line;
}

const CHILDREN_SECTION_HEADER = "## Children";

/**
 * Appends the epic-side `## Children` task list `parseChildTaskList` reads
 * back — one `- [ ] #<n> <title>` line per child, in filing order. GitHub
 * treats each item as a tracked reference and auto-checks it when that issue
 * closes, which is what gives the epic native task-list progress and is what
 * `parseChildTaskList` reads back to decide when every child is done.
 */
export function bodyWithChildTaskList(body: string, children: { number: number; title: string }[]): string {
  if (children.length === 0) return body;
  const section = [CHILDREN_SECTION_HEADER, ...children.map((c) => `- [ ] #${c.number} ${c.title}`)].join("\n");
  return body.trim().length > 0 ? `${body}\n\n${section}` : section;
}

/**
 * Reads the `## Children` task list back out of an epic body: one entry per
 * `- [ ] #<n>`/`- [x] #<n>` line under the header, `checked` reflecting
 * whichever GitHub itself last wrote there (see `bodyWithChildTaskList`).
 * Tolerant of a missing section (returns `[]`) and stops at the first
 * non-list-item line after the section starts, so trailing prose in the body
 * isn't misread as more children.
 */
export function parseChildTaskList(body: string): { number: number; checked: boolean }[] {
  const headerMatch = /^##\s*children\s*$/im.exec(body);
  if (!headerMatch) return [];
  const lines = body.slice(headerMatch.index + headerMatch[0].length).split(/\r?\n/);
  const items: { number: number; checked: boolean }[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const itemMatch = /^-\s*\[([ xX])\]\s*#(\d+)/.exec(line);
    if (!itemMatch) break;
    items.push({ number: Number(itemMatch[2]), checked: itemMatch[1]!.toLowerCase() === "x" });
  }
  return items;
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

/** Overwrites an issue's body — used to stamp the `## Children` task list onto a freshly-planned epic. */
export async function updateIssueBody(project: ProjectConfig, issueNumber: number, body: string): Promise<void> {
  await run("gh", ["issue", "edit", String(issueNumber), "--repo", project.githubRepo, "--body", body]);
}

/**
 * A single issue's number/title/body, or `undefined` on any fetch failure
 * (deleted issue, transient `gh` error) — callers that use this for prompt
 * framing treat a miss as "skip the context" rather than failing the ticket.
 */
export async function getIssue(project: ProjectConfig, issueNumber: number): Promise<{ number: number; title: string; body: string } | undefined> {
  try {
    return await runJson<{ number: number; title: string; body: string }>("gh", [
      "issue", "view", String(issueNumber),
      "--repo", project.githubRepo,
      "--json", "number,title,body",
    ]);
  } catch {
    return undefined;
  }
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

export interface TimestampedComment {
  author: string;
  body: string;
  createdAt: string;
  isStatusComment: boolean;
}

/**
 * Every comment on the issue with its author and timestamp — unlike
 * `getIssueComments`, the fleet status marker is flagged rather than dropped,
 * so a watermark-based caller can still advance past it instead of it being
 * silently invisible to `isNewerThan` comparisons.
 */
export async function getTimestampedIssueComments(project: ProjectConfig, issueNumber: number): Promise<TimestampedComment[]> {
  const comments = await listComments(project, issueNumber);
  return comments.map((c) => ({
    author: c.user.login,
    body: c.body,
    createdAt: c.created_at,
    isStatusComment: c.body.startsWith(STATUS_MARKER),
  }));
}

interface GhCollaborator {
  login: string;
  permissions?: { push?: boolean };
}

/** Per-repo cache of push-access logins, for the daemon process's whole lifetime — avoids a `gh api` call per commenter per cycle. */
const pushCollaboratorsCache = new Map<string, Promise<Set<string>>>();

/**
 * Logins with push access to the repo — the set allowed to steer a running
 * ticket via issue comments. Cached per repo for the daemon's lifetime; a
 * failed fetch evicts itself so the next call retries rather than caching the
 * failure forever.
 */
export function getPushCollaborators(project: ProjectConfig): Promise<Set<string>> {
  const cached = pushCollaboratorsCache.get(project.githubRepo);
  if (cached) return cached;
  const promise = runJson<GhCollaborator[]>("gh", [
    "api", `repos/${project.githubRepo}/collaborators`,
    "--paginate",
  ]).then((collaborators) => new Set(collaborators.filter((c) => c.permissions?.push).map((c) => c.login)));
  promise.catch(() => pushCollaboratorsCache.delete(project.githubRepo));
  pushCollaboratorsCache.set(project.githubRepo, promise);
  return promise;
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
 * `gh issue edit --add-assignee` is additive — it doesn't clear existing
 * assignees — which is exactly what lets two daemons racing to claim the
 * same issue both land in the assignee list for the set-then-verify check.
 */
export async function addAssignee(project: ProjectConfig, issueNumber: number, login: string): Promise<void> {
  await run("gh", [
    "issue", "edit", String(issueNumber),
    "--repo", project.githubRepo,
    "--add-assignee", login,
  ]);
}

export async function removeAssignee(project: ProjectConfig, issueNumber: number, login: string): Promise<void> {
  await run("gh", [
    "issue", "edit", String(issueNumber),
    "--repo", project.githubRepo,
    "--remove-assignee", login,
  ]);
}

export async function getIssueAssignees(project: ProjectConfig, issueNumber: number): Promise<string[]> {
  const { assignees } = await runJson<{ assignees: { login: string }[] }>("gh", [
    "issue", "view", String(issueNumber),
    "--repo", project.githubRepo,
    "--json", "assignees",
  ]);
  return assignees.map((a) => a.login);
}

/**
 * Drops every current assignee — used when an issue returns to the shared
 * pool (an operator restart) so the routing rule sees it as unassigned again
 * rather than still routed to whoever last claimed it.
 */
export async function clearAssignees(project: ProjectConfig, issueNumber: number): Promise<void> {
  const assignees = await getIssueAssignees(project, issueNumber);
  if (assignees.length === 0) return;
  const args = ["issue", "edit", String(issueNumber), "--repo", project.githubRepo];
  for (const login of assignees) args.push("--remove-assignee", login);
  await run("gh", args);
}

export interface StatusHeartbeat {
  timestamp: string;
  owner: string;
}

function formatHeartbeatLine(heartbeat: StatusHeartbeat): string {
  return `<!-- fleet-heartbeat: ${heartbeat.timestamp} owner: ${heartbeat.owner} -->`;
}

/**
 * Reads the heartbeat line back out of a status comment body. Tolerant of
 * comments written before this feature existed (no line at all, or one with
 * an unparseable timestamp) — those are treated the same as "no heartbeat"
 * by callers rather than throwing.
 */
export function parseHeartbeat(body: string): StatusHeartbeat | undefined {
  const match = HEARTBEAT_LINE_REGEX.exec(body);
  if (!match) return undefined;
  const [, timestamp, owner] = match;
  if (!timestamp || !owner || Number.isNaN(Date.parse(timestamp))) return undefined;
  return { timestamp, owner };
}

/** Stamps `heartbeat` onto `body`, replacing an existing heartbeat line or inserting one right after the status marker. */
function withFreshHeartbeat(body: string, heartbeat: StatusHeartbeat): string {
  const line = formatHeartbeatLine(heartbeat);
  if (HEARTBEAT_LINE_REGEX.test(body)) return body.replace(HEARTBEAT_LINE_REGEX, line);
  return body.replace(STATUS_MARKER, `${STATUS_MARKER}\n${line}`);
}

function findStatusComment(project: ProjectConfig, issueNumber: number): Promise<RestComment | undefined> {
  return listComments(project, issueNumber).then((comments) => comments.find((c) => c.body.startsWith(STATUS_MARKER)));
}

async function patchHeartbeat(project: ProjectConfig, existing: RestComment): Promise<void> {
  const owner = await getAuthenticatedLogin();
  const full = withFreshHeartbeat(existing.body, { timestamp: new Date().toISOString(), owner });
  await run("gh", [
    "api", `repos/${project.githubRepo}/issues/comments/${existing.id}`,
    "-X", "PATCH", "-f", `body=${full}`,
  ]);
}

/**
 * Error policy: the status comment only mirrors ticket state for humans on
 * GitHub — labels (via `swapLabel`) remain the source of truth the daemon
 * itself acts on. Callers treat a failure here as best-effort: log it and
 * continue, rather than letting a transient `gh` failure while posting a
 * comment escalate into a ticket reported as failed even though the actual
 * work succeeded.
 *
 * Every upsert also stamps a fresh heartbeat line (this daemon's login, now)
 * — the multi-daemon stale-claim detector's write side; see `refreshHeartbeat`
 * / `refreshHeartbeatIfStale` for the read-cycle refresh and
 * `getStatusCommentInfo` for the peer-side staleness read.
 */
export async function upsertStatusComment(project: ProjectConfig, issueNumber: number, body: string): Promise<void> {
  const owner = await getAuthenticatedLogin();
  const full = withFreshHeartbeat(`${STATUS_MARKER}\n${body}`, { timestamp: new Date().toISOString(), owner });
  const existing = await findStatusComment(project, issueNumber);
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

/** Unconditionally stamps a fresh heartbeat onto the existing status comment; a no-op when there isn't one yet. */
export async function refreshHeartbeat(project: ProjectConfig, issueNumber: number): Promise<void> {
  const existing = await findStatusComment(project, issueNumber);
  if (!existing) return;
  await patchHeartbeat(project, existing);
}

/**
 * Refreshes the heartbeat only once it's aged past `maxAgeMs` — the per-cycle
 * in-flight touch, gated so it isn't PATCHing the comment (and burning a `gh`
 * call) every single cycle for every ticket this daemon is actively working.
 */
export async function refreshHeartbeatIfStale(project: ProjectConfig, issueNumber: number, maxAgeMs: number): Promise<void> {
  const existing = await findStatusComment(project, issueNumber);
  if (!existing) return;
  const heartbeat = parseHeartbeat(existing.body);
  if (heartbeat && Date.now() - Date.parse(heartbeat.timestamp) < maxAgeMs) return;
  await patchHeartbeat(project, existing);
}

export interface StatusCommentInfo {
  createdAt: string;
  heartbeat?: StatusHeartbeat;
}

/**
 * The read side for a peer daemon's staleness check: `undefined` when there's
 * no status comment at all (too ambiguous to act on — see `isClaimStale`),
 * otherwise the comment's creation time plus whatever heartbeat it carries
 * (possibly none, for a pre-heartbeat claim).
 */
export async function getStatusCommentInfo(project: ProjectConfig, issueNumber: number): Promise<StatusCommentInfo | undefined> {
  const existing = await findStatusComment(project, issueNumber);
  if (!existing) return undefined;
  return { createdAt: existing.created_at, heartbeat: parseHeartbeat(existing.body) };
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

export function isNewerThan(ts: string, since: string | undefined): boolean {
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

export interface PrApprovalReview {
  author: string;
  state: string;
  submittedAt: string;
}

/**
 * Every review on the PR, unfiltered — auto-merge needs the latest state per
 * reviewer, not just what's new since a watermark. Paginated: an older
 * outstanding CHANGES_REQUESTED must not fall off a truncated first page and
 * go unseen by the auto-merge approval check.
 */
export async function getPrReviews(project: ProjectConfig, prUrl: string): Promise<PrApprovalReview[]> {
  const prNumber = issueNumberFromUrl(prUrl);
  const rawReviews = await runJson<GhReview[]>("gh", [
    "api", `repos/${project.githubRepo}/pulls/${prNumber}/reviews`,
    "--paginate",
  ]);
  return rawReviews.map((r) => ({ author: r.user?.login ?? "unknown", state: r.state, submittedAt: r.submitted_at }));
}

export interface PrOutcome {
  openedAt: string;
  mergedAt?: string;
  timeToMergeMs?: number;
  humanPushedAfterOpen: boolean;
  reviewRounds: number;
  reviewCommentCount: number;
}

interface GhPrCommitAuthor {
  login?: string;
}

interface GhPrCommit {
  authoredDate: string;
  authors: GhPrCommitAuthor[];
}

interface GhPrOutcomeJson {
  createdAt: string;
  mergedAt: string | null;
  commits: GhPrCommit[];
}

/**
 * Archived at cleanup alongside `prState`: how long the PR was open before
 * merging, whether anyone other than the daemon's own GitHub login pushed a
 * commit to the branch after the PR opened (a resumed worker session pushes
 * under that same login, so only a different author counts as human rework),
 * and how much human review it drew.
 */
export async function getPrOutcome(project: ProjectConfig, prUrl: string): Promise<PrOutcome> {
  const prNumber = issueNumberFromUrl(prUrl);
  const [detail, rawReviews, rawComments, botLogin] = await Promise.all([
    runJson<GhPrOutcomeJson>("gh", [
      "pr", "view", prUrl,
      "--repo", project.githubRepo,
      "--json", "createdAt,mergedAt,commits",
    ]),
    runJson<GhReview[]>("gh", ["api", `repos/${project.githubRepo}/pulls/${prNumber}/reviews`]),
    runJson<GhReviewComment[]>("gh", ["api", `repos/${project.githubRepo}/pulls/${prNumber}/comments`]),
    getAuthenticatedLogin(),
  ]);

  const humanPushedAfterOpen = detail.commits.some(
    (commit) =>
      isNewerThan(commit.authoredDate, detail.createdAt) &&
      commit.authors.some((author) => !!author.login && author.login !== botLogin),
  );

  return {
    openedAt: detail.createdAt,
    mergedAt: detail.mergedAt ?? undefined,
    timeToMergeMs: detail.mergedAt ? Date.parse(detail.mergedAt) - Date.parse(detail.createdAt) : undefined,
    humanPushedAfterOpen,
    reviewRounds: rawReviews.length,
    reviewCommentCount: rawComments.length,
  };
}

export interface PrCheck {
  name: string;
  bucket: string;
}

/**
 * `gh pr checks` exits non-zero whenever a check is pending/failing (and when
 * there are no checks at all), so this always allows failure — a PR with zero
 * checks reported is meant to read as "nothing blocking", not as an error.
 * But that "no checks" case must stay distinguishable from a genuine fetch
 * failure (rate limit, auth hiccup, network error): both can leave `stdout`
 * empty, and silently mapping *any* empty/unparseable output to `[]` would
 * make auto-merge read a transient `gh` failure as "checks are green" for an
 * action that isn't reversible. Only gh's own "no checks reported" message on
 * stderr is treated as the real zero-checks case; anything else throws so the
 * caller treats it the same as a failed reviews/mergeable fetch — skip this
 * candidate, retry next cycle.
 */
export async function getPrChecks(project: ProjectConfig, prUrl: string): Promise<PrCheck[]> {
  const { stdout, stderr } = await run(
    "gh",
    ["pr", "checks", prUrl, "--repo", project.githubRepo, "--json", "name,bucket"],
    { allowFailure: true },
  );
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      return JSON.parse(trimmed) as PrCheck[];
    } catch (err) {
      throw new Error(`could not parse \`gh pr checks\` output: ${trimmed}`, { cause: err });
    }
  }
  if (/no checks reported/i.test(stderr)) return [];
  throw new Error(`\`gh pr checks\` produced no output${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
}

let authenticatedLoginPromise: Promise<string> | undefined;

/**
 * The GitHub login the daemon's `gh` is authenticated as — the default
 * `approvers` allowlist for auto-merge. Cached for the process's lifetime;
 * a failed lookup evicts the cache so a later call retries instead of caching
 * the failure forever.
 */
export function getAuthenticatedLogin(): Promise<string> {
  if (!authenticatedLoginPromise) {
    authenticatedLoginPromise = runJson<{ login: string }>("gh", ["api", "user"]).then((u) => u.login);
    authenticatedLoginPromise.catch(() => {
      authenticatedLoginPromise = undefined;
    });
  }
  return authenticatedLoginPromise;
}

export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * Merges via `gh pr merge`. A PR the daemon finds already merged (e.g. a human
 * beat it to it) is treated as success rather than an error — the outcome
 * auto-merge wants, an issue-closing merge, already happened.
 */
export async function mergePullRequest(project: ProjectConfig, prUrl: string, method: MergeMethod): Promise<void> {
  const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
  try {
    await run("gh", ["pr", "merge", prUrl, "--repo", project.githubRepo, flag]);
  } catch (err) {
    const state = await getPrState(project, prUrl).catch(() => undefined);
    if (state === "MERGED") return;
    throw err;
  }
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
