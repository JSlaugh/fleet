import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpEntry } from "./types.ts";

/** The fleet checkout root — three levels above `packages/mcp/src/stamp`. */
export const FLEET_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
export const TEMPLATES_DIR = join(FLEET_DIR, "templates");
const SKILL_TEMPLATE_PATH = join(TEMPLATES_DIR, "fleet-backlog", "SKILL.md");
const MCP_TEMPLATE_PATH = join(TEMPLATES_DIR, "mcp.json.example");

export function readSkillTemplate(): string {
  return readFileSync(SKILL_TEMPLATE_PATH, "utf8");
}

export interface EntryTarget {
  project: string;
  /** Absolute path of the `fleet.config.json` the project name resolves through; the MCP is launched from the target repo, whose upward search would not find it. */
  configPath: string;
  /** Set when a daemon is known to run at this URL; omitted for a daemon-less setup, where the config decides. */
  daemonUrl?: string;
}

/**
 * The template carries `{{FLEET_DIR}}` rather than a literal path: the fleet
 * checkout's location differs per machine, and a stamped-verbatim absolute
 * path silently breaks the MCP server in every registered repo on any other
 * clone. Env is built here, not templated, since it depends on the target.
 */
export function buildFleetEntry(target: EntryTarget): McpEntry {
  const raw = readFileSync(MCP_TEMPLATE_PATH, "utf8").replace(/^﻿/, "").replaceAll("{{FLEET_DIR}}", FLEET_DIR.replace(/\\/g, "/"));
  const parsed = JSON.parse(raw) as { mcpServers: { fleet: { command: string; args: string[] } } };
  const env: Record<string, string> = {
    FLEET_PROJECT: target.project,
    FLEET_CONFIG: target.configPath.replace(/\\/g, "/"),
  };
  if (target.daemonUrl) env.FLEET_URL = target.daemonUrl;
  return { command: parsed.mcpServers.fleet.command, args: parsed.mcpServers.fleet.args, env };
}
