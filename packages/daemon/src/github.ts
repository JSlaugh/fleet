import { ALL_FLEET_LABELS, FLEET_LABELS, PRIORITY_LABELS, type ProjectConfig } from "@fleet/shared";
import { run, runJson } from "./exec.ts";

const STATUS_MARKER = "<!-- fleet-status -->";

export interface ReadyIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

interface GhIssueJson {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
}

interface GhCommentJson {
  id: string;
  body: string;
  author: { login: string };
}

export function priorityRank(labels: string[]): number {
  const index = PRIORITY_LABELS.findIndex((p) => labels.includes(p));
  return index === -1 ? PRIORITY_LABELS.length : index;
}

export async function listReadyIssues(project: ProjectConfig): Promise<ReadyIssue[]> {
  const issues = await runJson<GhIssueJson[]>("gh", [
    "issue", "list",
    "--repo", project.githubRepo,
    "--label", FLEET_LABELS.ready,
    "--state", "open",
    "--json", "number,title,body,labels",
    "--limit", "50",
  ]);
  return issues
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((l) => l.name),
    }))
    .sort((a, b) => priorityRank(a.labels) - priorityRank(b.labels) || a.number - b.number);
}

export async function getIssueComments(project: ProjectConfig, issueNumber: number): Promise<string[]> {
  const result = await runJson<{ comments: GhCommentJson[] }>("gh", [
    "issue", "view", String(issueNumber),
    "--repo", project.githubRepo,
    "--json", "comments",
  ]);
  return result.comments
    .filter((c) => !c.body.startsWith(STATUS_MARKER))
    .map((c) => `@${c.author.login}: ${c.body}`);
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
  const { comments } = await runJson<{ comments: GhCommentJson[] }>("gh", [
    "issue", "view", String(issueNumber),
    "--repo", project.githubRepo,
    "--json", "comments",
  ]);
  const existing = comments.find((c) => c.body.startsWith(STATUS_MARKER));
  if (existing) {
    await run("gh", [
      "api", `repos/${project.githubRepo}/issues/comments/${extractRestId(existing.id)}`,
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

function extractRestId(id: string): string {
  if (/^\d+$/.test(id)) return id;
  const decoded = Buffer.from(id, "base64").toString("utf8");
  const match = decoded.match(/(\d+)$/);
  if (!match) throw new Error(`Cannot extract REST id from comment id ${id}`);
  return match[1]!;
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
