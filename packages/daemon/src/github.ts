import {
  ALL_FLEET_LABELS,
  FLEET_LABELS,
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

export function toBoardTicket(project: ProjectConfig, issue: FleetIssue): BoardTicket | null {
  const status = boardStatusFromLabels(issue.labels);
  if (!status) return null;
  return {
    project: project.name,
    issueNumber: issue.number,
    title: issue.title,
    url: issue.url,
    status,
    priority: priorityOf(issue.labels),
  };
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
