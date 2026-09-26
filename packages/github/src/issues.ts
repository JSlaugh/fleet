import { PRIORITY_LABELS, log } from "@fleet/shared";
import { run, runJson } from "./exec.ts";

/**
 * The one field every helper here needs. `ProjectConfig` is structurally
 * compatible, so daemon call sites pass their project unchanged; the MCP
 * server, which has no project config, passes `{ githubRepo }` alone.
 */
export interface RepoRef {
  githubRepo: string;
}

/** GitHub rejects issue/comment/PR bodies over 65,536 chars with a 422 — clamp with a visible marker instead of failing the whole call. */
const MAX_BODY_CHARS = 65_000;
export function clampBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n…(truncated: body exceeded GitHub's length limit)`;
}

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

export interface FleetIssue extends ReadyIssue {
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

export function priorityRank(labels: string[]): number {
  const index = PRIORITY_LABELS.findIndex((p) => labels.includes(p));
  return index === -1 ? PRIORITY_LABELS.length : index;
}

export async function listFleetIssues(repo: RepoRef): Promise<FleetIssue[]> {
  const issues = await runJson<GhIssueJson[]>("gh", [
    "issue", "list",
    "--repo", repo.githubRepo,
    "--state", "open",
    "--json", "number,title,body,labels,url,author,assignees",
    "--limit", "1000",
  ]);
  if (issues.length >= 1000) {
    log("github", `WARNING: ${repo.githubRepo} returned 1000 open issues — the listing may be truncated and older fleet tickets invisible`);
  }
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
export async function listIssueStates(repo: RepoRef): Promise<{ open: Set<number>; all: Set<number> }> {
  const issues = await runJson<GhIssueStateJson[]>("gh", [
    "issue", "list",
    "--repo", repo.githubRepo,
    "--state", "all",
    "--json", "number,state",
    "--limit", "1000",
  ]);
  if (issues.length >= 1000) {
    log("github", `WARNING: ${repo.githubRepo} has 1000+ total issues — dependency/epic state checks may miss older open issues`);
  }
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
  repo: RepoRef,
  opts: { title: string; body: string; labels: string[] },
): Promise<{ number: number; url: string }> {
  const args = [
    "issue", "create",
    "--repo", repo.githubRepo,
    "--title", opts.title,
    "--body-file", "-",
  ];
  for (const label of opts.labels) args.push("--label", label);
  const { stdout } = await run("gh", args, { stdin: clampBody(opts.body) });
  const url = stdout.trim().split("\n").pop()?.trim() ?? "";
  return { number: issueNumberFromUrl(url), url };
}

/** Overwrites an issue's body — used to stamp the `## Children` task list onto a freshly-planned epic. */
export async function updateIssueBody(repo: RepoRef, issueNumber: number, body: string): Promise<void> {
  await run("gh", ["issue", "edit", String(issueNumber), "--repo", repo.githubRepo, "--body-file", "-"], { stdin: clampBody(body) });
}

/**
 * A single issue's number/title/body, or `undefined` on any fetch failure
 * (deleted issue, transient `gh` error) — callers that use this for prompt
 * framing treat a miss as "skip the context" rather than failing the ticket.
 */
export async function getIssue(repo: RepoRef, issueNumber: number): Promise<{ number: number; title: string; body: string; labels: string[] } | undefined> {
  try {
    const raw = await runJson<{ number: number; title: string; body: string | null; labels: { name: string }[] }>("gh", [
      "issue", "view", String(issueNumber),
      "--repo", repo.githubRepo,
      "--json", "number,title,body,labels",
    ]);
    return { number: raw.number, title: raw.title, body: raw.body ?? "", labels: raw.labels.map((l) => l.name) };
  } catch {
    return undefined;
  }
}

/**
 * Issue numbers whose body carries this epic's `Part-of: #<n>` stamp — the
 * GitHub-side "were children already filed?" check `finishPlanned` gates on,
 * which survives crashes and state-record wipes where a local marker wouldn't.
 * Searches all states: a closed child still proves filing happened.
 */
