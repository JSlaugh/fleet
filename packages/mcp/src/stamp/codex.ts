import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentStamper, McpEntry } from "./types.ts";

const FLEET_TABLE = "mcp_servers.fleet";

/** TOML basic strings accept the same escapes JSON does for everything a path or URL can contain. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Renders the `[mcp_servers.fleet]` table Codex reads — `env` as an inline table, as Codex's docs show it. */
export function renderCodexFleetTable(entry: McpEntry): string {
  const env = Object.entries(entry.env)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join(", ");
  return [
    `[${FLEET_TABLE}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    `env = { ${env} }`,
  ].join("\n");
}

const HEADER_LINE = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/;

function isFleetTableHeader(line: string): boolean {
  const m = HEADER_LINE.exec(line);
  if (!m) return false;
  const name = m[1]!.trim().replace(/\s+/g, "");
  return name === FLEET_TABLE || name.startsWith(`${FLEET_TABLE}.`);
}

/**
 * Line-level merge that never re-serializes the user's file: every existing
 * `[mcp_servers.fleet]` table (and any `[mcp_servers.fleet.*]` sub-table,
 * in case someone wrote `env` that way) is cut from its header through the
 * line before the next table header, and the fresh table is appended. All
 * other tables, comments and formatting are preserved verbatim, which a
 * parse-and-stringify round trip could not promise.
 */
export function mergeCodexConfig(existingRaw: string | undefined, entry: McpEntry): string {
  const lines = (existingRaw ?? "").replace(/^﻿/, "").split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (HEADER_LINE.test(line)) skipping = isFleetTableHeader(line);
    if (!skipping) kept.push(line);
  }
  const body = kept.join("\n").replace(/\s+$/, "");
  return `${body ? `${body}\n\n` : ""}${renderCodexFleetTable(entry)}\n`;
}

/** Codex: `.agents/skills/<name>/SKILL.md` (same SKILL.md format as Claude), `[mcp_servers.<name>]` in `.codex/config.toml`. */
export const codexStamper: AgentStamper = {
  kind: "codex",
  stamp(repoPath, entry, skillMarkdown) {
    const skillPath = join(repoPath, ".agents", "skills", "fleet-backlog", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, skillMarkdown);

    const configPath = join(repoPath, ".codex", "config.toml");
    mkdirSync(dirname(configPath), { recursive: true });
    const existingRaw = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
    writeFileSync(configPath, mergeCodexConfig(existingRaw, entry));

    return {
      written: [skillPath, configPath],
      notes: [`Codex only loads a project's .codex/config.toml from a trusted directory — mark ${repoPath} trusted in Codex if it is not already.`],
    };
  },
};
