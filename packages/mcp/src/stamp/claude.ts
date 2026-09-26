import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentStamper, McpEntry } from "./types.ts";

function stripBom(raw: string): string {
  return raw.replace(/^﻿/, "");
}

/**
 * Pure merge: sets/replaces only `mcpServers.fleet`, preserving every other
 * key (and every other server) byte-for-byte semantically. `existingRaw` is
 * `undefined` when the repo has no `.mcp.json` yet.
 */
export function mergeMcpConfig(existingRaw: string | undefined, fleetEntry: McpEntry): string {
  let parsed: Record<string, unknown> = {};
  if (existingRaw !== undefined) {
    try {
      parsed = JSON.parse(stripBom(existingRaw)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`existing .mcp.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const mcpServers = parsed.mcpServers && typeof parsed.mcpServers === "object" ? (parsed.mcpServers as Record<string, unknown>) : {};
  const merged = { ...parsed, mcpServers: { ...mcpServers, fleet: fleetEntry } };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Claude Code expands `${VAR:-default}` in `.mcp.json`, so the launcher is
 * addressed from the project root even when Claude starts in a subdirectory;
 * the fallback keeps it working where that variable isn't set.
 */
export function claudeEntry(entry: McpEntry): McpEntry {
  return { ...entry, args: entry.args.map((a) => (a.startsWith(".fleet-mcp/") ? `\${CLAUDE_PROJECT_DIR:-.}/${a}` : a)) };
}

/** Claude Code: `.claude/skills/<name>/SKILL.md` for skills, `.mcp.json` for project-scoped MCP servers. */
export const claudeStamper: AgentStamper = {
  kind: "claude",
  stamp(repoPath, entry, skillMarkdown) {
    const skillPath = join(repoPath, ".claude", "skills", "fleet-backlog", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, skillMarkdown);

    const mcpPath = join(repoPath, ".mcp.json");
    const existingRaw = existsSync(mcpPath) ? readFileSync(mcpPath, "utf8") : undefined;
    writeFileSync(mcpPath, mergeMcpConfig(existingRaw, claudeEntry(entry)));

    return { written: [skillPath, mcpPath], notes: [] };
  },
};
