import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "@fleet/shared";
import { run, runShell } from "./exec.ts";
import { log } from "./log.ts";

export interface Worktree {
  path: string;
  branch: string;
}

export async function createWorktree(
  project: ProjectConfig,
  issueNumber: number,
  worktreeRoot: string,
): Promise<Worktree> {
  const branch = `fleet/${issueNumber}`;
  const path = join(worktreeRoot, project.name, String(issueNumber));
  mkdirSync(join(worktreeRoot, project.name), { recursive: true });

  await run("git", ["-C", project.repoPath, "fetch", "origin", project.defaultBranch], { allowFailure: true });
  await run("git", ["-C", project.repoPath, "worktree", "remove", "--force", path], { allowFailure: true });
  await run("git", ["-C", project.repoPath, "worktree", "prune"]);
  await run("git", ["-C", project.repoPath, "branch", "-D", branch], { allowFailure: true });
  await run("git", [
    "-C", project.repoPath,
    "worktree", "add", path,
    "-b", branch,
    `origin/${project.defaultBranch}`,
  ]);

  if (project.setupCommand) {
    log("worktree", `${project.name}#${issueNumber}: running setup: ${project.setupCommand}`);
    await runShell(project.setupCommand, path);
  }
  return { path, branch };
}

export async function removeWorktree(project: ProjectConfig, worktreePath: string): Promise<void> {
  await run("git", ["-C", project.repoPath, "worktree", "remove", "--force", worktreePath], { allowFailure: true });
}

export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await run("git", ["-C", worktreePath, "push", "-u", "origin", branch]);
}

export async function hasCommits(project: ProjectConfig, worktreePath: string): Promise<boolean> {
  const { stdout } = await run("git", [
    "-C", worktreePath,
    "rev-list", "--count", `origin/${project.defaultBranch}..HEAD`,
  ]);
  return parseInt(stdout.trim(), 10) > 0;
}
