import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpEntry } from "./types.ts";

/** The fleet checkout root — four levels above `packages/mcp/src/stamp`. Resolved at runtime; never stamped into a repo. */
export const FLEET_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
export const TEMPLATES_DIR = join(FLEET_DIR, "templates");
const SKILL_TEMPLATE_PATH = join(TEMPLATES_DIR, "fleet-backlog", "SKILL.md");
const LAUNCHER_TEMPLATE_PATH = join(TEMPLATES_DIR, "fleet-mcp", "launch.mjs");

/** Where the launcher lands in a stamped repo, relative to its root. */
export const LAUNCHER_PATH = ".fleet-mcp/launch.mjs";

export function readSkillTemplate(): string {
  return readFileSync(SKILL_TEMPLATE_PATH, "utf8");
}

export function readLauncherTemplate(): string {
  return readFileSync(LAUNCHER_TEMPLATE_PATH, "utf8");
}

export interface EntryTarget {
  project: string;
}

/**
 * The committed registration is identical on every machine: it runs the
 * stamped launcher, which finds the gitignored `fleet.config.json` (holding
 * `fleetDir`, `dashboardPort` and the project) at runtime. Nothing here may
 * name a path — a stamped absolute path leaks one machine's layout into the
 * repo and breaks the server on every other clone.
 */
export function buildFleetEntry(target: EntryTarget): McpEntry {
  return { command: "node", args: [LAUNCHER_PATH], env: { FLEET_PROJECT: target.project } };
}
