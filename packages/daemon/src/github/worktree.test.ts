import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "@fleet/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectBranchDiff,
  collectBranchSummary,
  createWorktree,
  deleteRemoteBranch,
  hasCommits,
  pushBranch,
  removeWorktree,
} from "./worktree.ts";

const TEST_TIMEOUT = 20_000;

const dirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** JSON is valid YAML, so this sidesteps YAML-quoting headaches in fixtures. */
function commitFleetYaml(project: ProjectConfig, spec: unknown): void {
  writeFileSync(join(project.repoPath, "fleet.yaml"), JSON.stringify(spec));
  git(project.repoPath, ["add", "fleet.yaml"]);
  git(project.repoPath, ["commit", "-q", "-m", "add fleet.yaml"]);
  git(project.repoPath, ["push", "-q", "origin", project.defaultBranch]);
}

function nodeStep(name: string, script: string): { name: string; run: string } {
  return { name, run: `"${process.execPath}" -e "${script}"` };
}

/** A real `origin` bare repo plus a real working clone with one commit on `main`, pushed. */
function setupProject(): ProjectConfig {
  const originDir = makeTempDir("fleet-wt-origin-");
  git(originDir, ["init", "--bare", "-q"]);

  const repoPath = makeTempDir("fleet-wt-repo-");
  git(repoPath, ["init", "-q", "-b", "main"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "initial"]);
  git(repoPath, ["remote", "add", "origin", originDir]);
  git(repoPath, ["push", "-q", "origin", "main"]);

  return {
    name: "alpha",
    repoPath,
    githubRepo: "acme/alpha",
    defaultBranch: "main",
    maxConcurrent: 1,
    maxInReview: 3,
    planChildrenReady: false,
    autoElevateOnFailure: true,
    autoAddressReviews: true,
    machineReview: false,
    autoMerge: false,
    mergeMethod: "squash",
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createWorktree", () => {
  it(
    "checks out a new worktree on fleet/<issue> from origin/<defaultBranch>",
    async () => {
      const project = setupProject();
      const worktreeRoot = makeTempDir("fleet-wt-root-");

      const wt = await createWorktree(project, 101, worktreeRoot);

      expect(wt.branch).toBe("fleet/101");
      expect(existsSync(join(wt.path, "README.md"))).toBe(true);
      expect(git(wt.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("fleet/101");
    },
    TEST_TIMEOUT,
  );

  it(
    "runs the project's setupCommand inside the new worktree",
    async () => {
      const project = setupProject();
      project.setupCommand = `"${process.execPath}" -e "require('fs').writeFileSync('marker.txt','ok')"`;
      const worktreeRoot = makeTempDir("fleet-wt-root-");

      const wt = await createWorktree(project, 102, worktreeRoot);

      expect(existsSync(join(wt.path, "marker.txt"))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "tolerates and replaces a pre-existing worktree/branch for the same issue (--force / -D)",
    async () => {
      const project = setupProject();
      const worktreeRoot = makeTempDir("fleet-wt-root-");

      const first = await createWorktree(project, 103, worktreeRoot);
      // An untracked file makes plain `git worktree remove` refuse without --force.
      writeFileSync(join(first.path, "scratch.txt"), "dirty");

      const second = await createWorktree(project, 103, worktreeRoot);

      expect(second.path).toBe(first.path);
      expect(existsSync(join(second.path, "scratch.txt"))).toBe(false);
      expect(git(second.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("fleet/103");
    },
    TEST_TIMEOUT,
  );
});

describe("createWorktree with fleet.yaml", () => {
  it(
    "runs fleet.yaml's steps in order and ignores setupCommand entirely when fleet.yaml is present",
    async () => {
      const project = setupProject();
      project.setupCommand = `"${process.execPath}" -e "require('fs').writeFileSync('should-not-run.txt','x')"`;
      commitFleetYaml(project, {
        setup: [
          nodeStep("step-one", "require('fs').writeFileSync('order.txt','1')"),
          nodeStep("step-two", "require('fs').appendFileSync('order.txt','2')"),
        ],
      });
      const worktreeRoot = makeTempDir("fleet-wt-root-");

      const wt = await createWorktree(project, 201, worktreeRoot);

      expect(readFileSync(join(wt.path, "order.txt"), "utf8")).toBe("12");
      expect(existsSync(join(wt.path, "should-not-run.txt"))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "runs the profile matching a fleet:type:<name> label, falling back to default steps otherwise",
    async () => {
      const project = setupProject();
      commitFleetYaml(project, {
        setup: {
          default: [nodeStep("default-step", "require('fs').writeFileSync('default.txt','ok')")],
          frontend: [nodeStep("frontend-step", "require('fs').writeFileSync('frontend.txt','ok')")],
        },
      });
      const worktreeRoot = makeTempDir("fleet-wt-root-");

      const defaultWt = await createWorktree(project, 202, worktreeRoot, ["fleet:ready"]);
      expect(existsSync(join(defaultWt.path, "default.txt"))).toBe(true);
      expect(existsSync(join(defaultWt.path, "frontend.txt"))).toBe(false);

      const frontendWt = await createWorktree(project, 203, worktreeRoot, ["fleet:ready", "fleet:type:frontend"]);
      expect(existsSync(join(frontendWt.path, "frontend.txt"))).toBe(true);
      expect(existsSync(join(frontendWt.path, "default.txt"))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "names the failing step when a setup step fails",
    async () => {
      const project = setupProject();
      commitFleetYaml(project, {
        setup: [nodeStep("build-storybook", "process.exit(3)")],
      });
      const worktreeRoot = makeTempDir("fleet-wt-root-");

      await expect(createWorktree(project, 204, worktreeRoot)).rejects.toThrow(/setup step "build-storybook" failed/);
    },
    TEST_TIMEOUT,
  );

  it(
    "fails the claim on a malformed fleet.yaml instead of silently falling back to setupCommand",
    async () => {
      const project = setupProject();
      project.setupCommand = `"${process.execPath}" -e "require('fs').writeFileSync('should-not-run.txt','x')"`;
      writeFileSync(join(project.repoPath, "fleet.yaml"), "setup: not-a-list-or-map\n");
      git(project.repoPath, ["add", "fleet.yaml"]);
      git(project.repoPath, ["commit", "-q", "-m", "add malformed fleet.yaml"]);
      git(project.repoPath, ["push", "-q", "origin", project.defaultBranch]);
      const worktreeRoot = makeTempDir("fleet-wt-root-");

      await expect(createWorktree(project, 205, worktreeRoot)).rejects.toThrow(/fleet\.yaml is invalid/);
    },
    TEST_TIMEOUT,
  );
});

describe("removeWorktree", () => {
  it(
    "removes the checkout directory",
    async () => {
      const project = setupProject();
      const worktreeRoot = makeTempDir("fleet-wt-root-");
      const wt = await createWorktree(project, 104, worktreeRoot);
      expect(existsSync(wt.path)).toBe(true);

      await removeWorktree(project, wt.path);

      expect(existsSync(wt.path)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "does not throw when the worktree path does not exist (best-effort)",
    async () => {
      const project = setupProject();
      await expect(removeWorktree(project, join(project.repoPath, "never-existed"))).resolves.toBeUndefined();
    },
    TEST_TIMEOUT,
  );
});

describe("pushBranch / deleteRemoteBranch", () => {
  it(
    "pushBranch publishes the worktree's branch and commits to origin",
    async () => {
      const project = setupProject();
      const worktreeRoot = makeTempDir("fleet-wt-root-");
      const wt = await createWorktree(project, 105, worktreeRoot);
      writeFileSync(join(wt.path, "new.txt"), "content");
      git(wt.path, ["add", "."]);
      git(wt.path, ["commit", "-q", "-m", "add new file"]);

      await pushBranch(wt.path, wt.branch);

      const originDir = project.repoPath; // any clone can query the shared object store via the remote
      const log = execFileSync("git", ["-C", originDir, "log", "-1", "--format=%s", `origin/${wt.branch}`], {
        encoding: "utf8",
      });
      expect(log.trim()).toBe("add new file");
    },
    TEST_TIMEOUT,
  );

  it(
    "deleteRemoteBranch removes a pushed branch, and is a no-op when it's already gone",
    async () => {
      const project = setupProject();
      const worktreeRoot = makeTempDir("fleet-wt-root-");
      const wt = await createWorktree(project, 106, worktreeRoot);
      await pushBranch(wt.path, wt.branch);

      await deleteRemoteBranch(project, wt.branch);

      git(project.repoPath, ["fetch", "origin", "--prune"]);
      expect(() => git(project.repoPath, ["rev-parse", `origin/${wt.branch}`])).toThrow();

      await expect(deleteRemoteBranch(project, wt.branch)).resolves.toBeUndefined();
    },
    TEST_TIMEOUT,
  );
});

describe("collectBranchDiff / hasCommits", () => {
  it(
    "reports no commits on a freshly created worktree",
    async () => {
      const project = setupProject();
      const worktreeRoot = makeTempDir("fleet-wt-root-");
      const wt = await createWorktree(project, 107, worktreeRoot);

      expect(await hasCommits(project, wt.path)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "reports the diff, commit log, and hasCommits=true once a commit is made",
    async () => {
      const project = setupProject();
      const worktreeRoot = makeTempDir("fleet-wt-root-");
      const wt = await createWorktree(project, 108, worktreeRoot);
      writeFileSync(join(wt.path, "new.txt"), "hello world\n");
      git(wt.path, ["add", "."]);
      git(wt.path, ["commit", "-q", "-m", "add new.txt"]);

      expect(await hasCommits(project, wt.path)).toBe(true);
      const { diff, commits } = await collectBranchDiff(project, wt.path);
      expect(diff).toContain("new.txt");
      expect(diff).toContain("hello world");
      expect(commits).toContain("add new.txt");
    },
    TEST_TIMEOUT,
  );
});

describe("collectBranchSummary", () => {
  it(
    "reports empty commits/files on a freshly created worktree",
    async () => {
      const project = setupProject();
      const worktreeRoot = makeTempDir("fleet-wt-root-");
      const wt = await createWorktree(project, 109, worktreeRoot);

      const summary = await collectBranchSummary(project, wt.path);
      expect(summary).toEqual({ commits: "", filesChanged: [] });
    },
    TEST_TIMEOUT,
  );

  it(
    "reports the commit oneline log and changed file names once a commit is made",
    async () => {
      const project = setupProject();
      const worktreeRoot = makeTempDir("fleet-wt-root-");
      const wt = await createWorktree(project, 110, worktreeRoot);
      writeFileSync(join(wt.path, "new.txt"), "hello world\n");
      git(wt.path, ["add", "."]);
      git(wt.path, ["commit", "-q", "-m", "add new.txt"]);

      const { commits, filesChanged } = await collectBranchSummary(project, wt.path);
      expect(commits).toContain("add new.txt");
      expect(filesChanged).toEqual(["new.txt"]);
    },
    TEST_TIMEOUT,
  );
});
