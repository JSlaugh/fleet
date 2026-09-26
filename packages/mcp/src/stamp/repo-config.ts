import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentKind } from "@fleet/shared";

export interface RepoConfigInput {
  /** Where fleet is cloned on this machine. */
  fleetDir: string;
  /** Set when a daemon manages this project, so the MCP registers its board/history tools. */
  dashboardPort?: number;
  project: { name: string; githubRepo: string; agents?: AgentKind[]; intakeLint?: boolean };
}

/** Same directory, seen through symlinks/junctions and (on Windows) case-insensitively. */
export function sameDir(a: string, b: string): boolean {
  const canonical = (p: string) => {
    let real = resolve(p);
    try {
      real = realpathSync.native(real);
    } catch {
      // Not on disk (yet): compare the resolved path as-is.
    }
    return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
  };
  return canonical(a) === canonical(b);
}

function isTracked(repoPath: string, file: string): boolean {
  try {
    execFileSync("git", ["-C", repoPath, "ls-files", "--error-unmatch", file], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CONFIG_FILE = "fleet.config.json";

/**
 * Writes the repo's machine-local `fleet.config.json` — the one place a
 * stamped repo learns where fleet lives — and makes sure the repo ignores it.
 * Merges into an existing file: `fleetDir`/`dashboardPort` are refreshed, the
 * project entry is merged by name (keys the caller doesn't set survive), every
 * other key is kept. Returns the paths written, or none when `repoPath` is the
 * fleet checkout itself (its own daemon config already sits there and needs
 * no `fleetDir`). Refuses — rather than corrupt or leak — a daemon config
 * (any file with `worktreeRoot`) and a `fleet.config.json` git already tracks,
 * since `.gitignore` can't untrack it and the next commit would carry the path.
 */
export function writeRepoConfig(repoPath: string, input: RepoConfigInput): string[] {
  if (sameDir(repoPath, input.fleetDir)) return [];
  const configPath = join(repoPath, CONFIG_FILE);
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`existing ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ("worktreeRoot" in config) {
      throw new Error(`${configPath} is a fleet daemon config — not writing a repo config over it. Is ${repoPath} another fleet checkout?`);
    }
  }
  if (isTracked(repoPath, CONFIG_FILE)) {
    throw new Error(
      `${configPath} is tracked by git, so writing this machine's fleetDir into it would be committed — untrack it (git rm --cached ${CONFIG_FILE}) and re-run.`,
    );
  }
  const existing = Array.isArray(config.projects) ? (config.projects as Record<string, unknown>[]) : [];
  const prior = existing.find((p) => p.name === input.project.name);
  const next = {
    ...config,
    fleetDir: input.fleetDir.replace(/\\/g, "/"),
    ...(input.dashboardPort !== undefined ? { dashboardPort: input.dashboardPort } : {}),
    projects: [...existing.filter((p) => p !== prior), { ...prior, ...input.project }],
  };
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return [configPath, ...ensureIgnored(repoPath, CONFIG_FILE)];
}

/** Appends `entry` to the repo's `.gitignore` unless a line already ignores it. */
export function ensureIgnored(repoPath: string, entry: string): string[] {
  const path = join(repoPath, ".gitignore");
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(`/${entry}`)) return [];
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const prefix = raw.length === 0 || raw.endsWith("\n") ? "" : eol;
  writeFileSync(path, `${raw}${prefix}${entry}${eol}`);
  return [path];
}
