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
 * Inline `node -e` bootstrap: walks up from wherever the agent was started to
 * the nearest `.fleet-mcp/launch.mjs` and imports it. A relative launcher path
 * would resolve against the agent's working directory, which is a
 * subdirectory whenever Claude Code or Codex is started below the repo root
 * (both find their project config by walking up; neither re-roots the cwd).
 */
export const LAUNCHER_BOOTSTRAP = [
  'const p=require("path"),f=require("fs");',
  "for(let d=process.cwd();;d=p.dirname(d)){",
  'const l=p.join(d,".fleet-mcp","launch.mjs");',
  'if(f.existsSync(l)){import(require("url").pathToFileURL(l).href);break}',
  'if(p.dirname(d)===d){console.error("fleet: no .fleet-mcp/launch.mjs found above "+process.cwd());process.exit(1)}}',
].join("");

/**
 * The committed registration is identical on every machine: it runs the
 * stamped launcher, which finds the gitignored `fleet.config.json` (holding
 * `fleetDir`, `dashboardPort` and the project) at runtime. Nothing here may
 * name a path — a stamped absolute path leaks one machine's layout into the
 * repo and breaks the server on every other clone.
 */
export function buildFleetEntry(target: EntryTarget): McpEntry {
  return { command: "node", args: ["-e", LAUNCHER_BOOTSTRAP], env: { FLEET_PROJECT: target.project } };
}
