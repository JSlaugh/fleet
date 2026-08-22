import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { selectSetupProfile, teardownForType, type ProjectConfig } from "@fleet/shared";
import { readBuildSpec } from "./buildspec.ts";
import { run, runShell, type RunResult } from "./exec.ts";
import { log } from "../log.ts";

export interface Worktree {
  path: string;
  branch: string;
  /** The `fleet:type:<name>` this claim's `fleet.yaml` setup profile actually matched — undefined when untyped, unmatched, or the repo has no profile map. */
  type?: string;
  /** True when the selected profile declares `teardown:` steps — the claim records it as `teardownPending` so removal paths know to tear down first. */
  hasTeardown?: boolean;
}

/**
 * The per-worktree parameters every setup and teardown step runs with, so a
 * step can derive unique resource names/ports for its worktree (e.g.
 * `docker compose -p ${FLEET_PROJECT}-wt-${FLEET_ISSUE} up -d`).
 */
function stepEnv(project: ProjectConfig, issueNumber: number, worktreePath: string): Record<string, string> {
  return {
    FLEET_ISSUE: String(issueNumber),
    FLEET_PROJECT: project.name,
    FLEET_WORKTREE: worktreePath,
  };
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
  let type: string | undefined;
  let hasTeardown: boolean | undefined;
  if (spec) {
    const { profile, steps, teardown, type: matchedType, warning } = selectSetupProfile(spec, issueLabels);
    type = matchedType;
    hasTeardown = (teardown?.length ?? 0) > 0 || undefined;
    if (warning) log("worktree", `${project.name}#${issueNumber}: ${warning}`);
    for (const step of steps) {
      log("worktree", `${project.name}#${issueNumber}: running setup step "${step.name}" (profile "${profile}")`);
      try {
        await runShell(step.run, path, stepEnv(project, issueNumber, path));
      } catch (err) {
        const message = `setup step "${step.name}" failed: ${err instanceof Error ? err.message : String(err)}`;
        if (step.allowFailure) {
          log("worktree", `${project.name}#${issueNumber}: ${message} (allowFailure: true, continuing)`);
          continue;
        }
        throw new Error(message);
      }
    }
  } else if (project.setupCommand) {
    log("worktree", `${project.name}#${issueNumber}: running setup: ${project.setupCommand}`);
    await runShell(project.setupCommand, path, stepEnv(project, issueNumber, path));
  }
  return { path, branch, type, hasTeardown };
}

/**
 * Runs the ticket's declared `teardown:` steps, releasing whatever
 * per-worktree resources its setup provisioned. Wholly best-effort — every
 * failure (malformed spec, missing profile, failing step) is logged and
 * collected, never thrown, because teardown must never block a ticket's
 * completion or cleanup. The spec is read from the worktree when it still
 * exists, falling back to the project's main checkout so an already-removed
 * worktree (startup recovery) can still resolve its steps; the steps run in
 * whichever of the two directories exists, with the same `FLEET_*` variables
 * setup ran with. Returns undefined when there was nothing to run.
 */
export async function runTeardown(
  project: ProjectConfig,
  issueNumber: number,
  worktreePath: string,
  ticketType: string | undefined,
): Promise<{ failures: string[] } | undefined> {
  let steps;
  try {
    const spec = readBuildSpec(worktreePath) ?? readBuildSpec(project.repoPath);
    steps = spec ? teardownForType(spec, ticketType) : undefined;
  } catch (err) {
    log("worktree", `${project.name}#${issueNumber}: could not resolve teardown steps: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (!steps || steps.length === 0) return undefined;
  const cwd = existsSync(worktreePath) ? worktreePath : project.repoPath;
  const failures: string[] = [];
  for (const step of steps) {
    log("worktree", `${project.name}#${issueNumber}: running teardown step "${step.name}"`);
    try {
      await runShell(step.run, cwd, stepEnv(project, issueNumber, worktreePath));
    } catch (err) {
      const message = `teardown step "${step.name}" failed: ${err instanceof Error ? err.message : String(err)}`;
      failures.push(message);
      log("worktree", `${project.name}#${issueNumber}: ${message} (best-effort, continuing)`);
    }
  }
  return { failures };
}

/** Best-effort (allowFailure) — callers that care whether it actually worked read the returned stderr. */
export function removeWorktree(project: ProjectConfig, worktreePath: string): Promise<RunResult> {
  return run("git", ["-C", project.repoPath, "worktree", "remove", "--force", worktreePath], { allowFailure: true });
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
