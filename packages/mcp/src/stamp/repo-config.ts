import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentKind } from "@fleet/shared";

export interface RepoConfigInput {
  /** Where fleet is cloned on this machine. */
  fleetDir: string;
  /** Set when a daemon manages this project, so the MCP registers its board/history tools. */
  dashboardPort?: number;
  project: { name: string; githubRepo: string; agents?: AgentKind[] };
}

const CONFIG_FILE = "fleet.config.json";

/**
 * Writes the repo's machine-local `fleet.config.json` — the one place a
 * stamped repo learns where fleet lives — and makes sure the repo ignores it.
 * Merges into an existing file: `fleetDir`/`dashboardPort` are refreshed, the
 * project entry is upserted by name, every other key is kept. Returns the
 * paths written, or none when `repoPath` is the fleet checkout itself (its
 * own daemon config already sits there and needs no `fleetDir`).
 */
export function writeRepoConfig(repoPath: string, input: RepoConfigInput): string[] {
  if (resolve(repoPath) === resolve(input.fleetDir)) return [];
  const configPath = join(repoPath, CONFIG_FILE);
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`existing ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const projects = Array.isArray(config.projects) ? (config.projects as { name?: string }[]).filter((p) => p.name !== input.project.name) : [];
  const next = {
    ...config,
    fleetDir: input.fleetDir.replace(/\\/g, "/"),
    ...(input.dashboardPort !== undefined ? { dashboardPort: input.dashboardPort } : {}),
    projects: [...projects, input.project],
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
