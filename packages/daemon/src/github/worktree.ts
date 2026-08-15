import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { selectSetupProfile, type ProjectConfig } from "@fleet/shared";
import { readBuildSpec } from "./buildspec.ts";
import { run, runShell } from "./exec.ts";
import { log } from "../log.ts";

export interface Worktree {
  path: string;
  branch: string;
}

export async function createWorktree(
  project: ProjectConfig,
  issueNumber: number,
  worktreeRoot: string,
  issueLabels: string[] = [],
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

  // A repo-declared fleet.yaml wins outright over the operator's setupCommand
  // for this claim — no silent fallback, so a malformed spec fails loudly here
  // rather than quietly running (or skipping) the old setup path.
  const spec = readBuildSpec(path);
  if (spec) {
    const { profile, steps, warning } = selectSetupProfile(spec, issueLabels);
    if (warning) log("worktree", `${project.name}#${issueNumber}: ${warning}`);
    for (const step of steps) {
      log("worktree", `${project.name}#${issueNumber}: running setup step "${step.name}" (profile "${profile}")`);
      try {
        await runShell(step.run, path);
      } catch (err) {
        throw new Error(`setup step "${step.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (project.setupCommand) {
    log("worktree", `${project.name}#${issueNumber}: running setup: ${project.setupCommand}`);
    await runShell(project.setupCommand, path);
  }
  return { path, branch };
}

export async function removeWorktree(project: ProjectConfig, worktreePath: string): Promise<void> {
  await run("git", ["-C", project.repoPath, "worktree", "remove", "--force", worktreePath], { allowFailure: true });
}

/** Best-effort: the remote branch may already be gone (GitHub auto-delete, manual prune). */
export async function deleteRemoteBranch(project: ProjectConfig, branch: string): Promise<void> {
  await run("git", ["-C", project.repoPath, "push", "origin", "--delete", branch], { allowFailure: true });
}

export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await run("git", ["-C", worktreePath, "push", "-u", "origin", branch]);
}

/** The branch's full diff and commit list against the PR base, for the machine reviewer's prompt. */
export async function collectBranchDiff(
  project: ProjectConfig,
  worktreePath: string,
): Promise<{ diff: string; commits: string }> {
  const { stdout: diff } = await run("git", ["-C", worktreePath, "diff", `origin/${project.defaultBranch}...HEAD`]);
  const { stdout: commits } = await run("git", ["-C", worktreePath, "log", "--oneline", `origin/${project.defaultBranch}..HEAD`]);
  return { diff, commits: commits.trim() };
}

/** Commit list and changed file names against the PR base — cheaper than `collectBranchDiff` for callers that don't need the full diff body (e.g. a failure post-mortem). */
export async function collectBranchSummary(
  project: ProjectConfig,
  worktreePath: string,
): Promise<{ commits: string; filesChanged: string[] }> {
  const { stdout: commits } = await run("git", ["-C", worktreePath, "log", "--oneline", `origin/${project.defaultBranch}..HEAD`]);
  const { stdout: files } = await run("git", ["-C", worktreePath, "diff", "--name-only", `origin/${project.defaultBranch}...HEAD`]);
  return { commits: commits.trim(), filesChanged: files.trim().split("\n").filter(Boolean) };
}

export async function hasCommits(project: ProjectConfig, worktreePath: string): Promise<boolean> {
  const { stdout } = await run("git", [
    "-C", worktreePath,
    "rev-list", "--count", `origin/${project.defaultBranch}..HEAD`,
  ]);
  return parseInt(stdout.trim(), 10) > 0;
}
