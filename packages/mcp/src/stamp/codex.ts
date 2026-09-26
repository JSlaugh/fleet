import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentStamper, McpEntry } from "./types.ts";

const FLEET_TABLE = "mcp_servers.fleet";
const FLEET_PATH = ["mcp_servers", "fleet"];

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

const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const DOTTED = String.raw`${KEY}(?:\s*\.\s*${KEY})*`;
const HEADER_LINE = new RegExp(String.raw`^\s*\[\[?\s*(${DOTTED})\s*\]\]?\s*(?:#.*)?$`);
const KEY_LINE = new RegExp(String.raw`^\s*(${DOTTED})\s*=`);
const KEY_SEGMENT = new RegExp(String.raw`\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:\.|$)`, "gy");

/** `a."b.c".'d'` → `["a", "b.c", "d"]`. */
function keyPath(dotted: string): string[] {
  const segments: string[] = [];
  KEY_SEGMENT.lastIndex = 0;
  for (let m = KEY_SEGMENT.exec(dotted); m && m[0] !== ""; m = KEY_SEGMENT.exec(dotted)) {
    if (m[1] !== undefined) segments.push(m[1]);
    else if (m[2] !== undefined) segments.push(JSON.parse(`"${m[2]}"`) as string);
    else segments.push(m[3] ?? "");
  }
  return segments;
}

const isFleetPath = (path: string[]) => path[0] === FLEET_PATH[0] && path[1] === FLEET_PATH[1];

interface ScanState {
  /** Open `[` brackets in a multi-line array value. */
  depth: number;
  /** Inside a `"""` or `'''` multi-line string. */
  multiline?: '"""' | "'''";
}

/** Advances bracket depth and multi-line-string state across one line, ignoring brackets in strings and comments. */
function scanValueLine(line: string, state: ScanState): void {
  let i = 0;
  while (i < line.length) {
    if (state.multiline) {
      const end = line.indexOf(state.multiline, i);
      if (end === -1) return;
      i = end + 3;
      state.multiline = undefined;
      continue;
    }
    const ch = line[i]!;
    if (ch === "#") return;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.multiline = line.slice(i, i + 3) as '"""' | "'''";
      i += 3;
    } else if (ch === '"' || ch === "'") {
      i++;
      while (i < line.length && line[i] !== ch) i += ch === '"' && line[i] === "\\" ? 2 : 1;
      i++;
    } else {
      if (ch === "[") state.depth++;
      else if (ch === "]") state.depth = Math.max(0, state.depth - 1);
      i++;
    }
  }
}

/**
 * Line-level merge that never re-serializes the user's file: every existing
 * `[mcp_servers.fleet]` table (and any `[mcp_servers.fleet.*]` sub-table, in
 * case someone wrote `env` that way, with bare or quoted keys) is cut from its
 * header through the line before the next table header, and the fresh table
 * is appended. All other tables, comments, formatting and the file's line
 * endings are preserved verbatim, which a parse-and-stringify round trip could
 * not promise. Comments directly above the next table are kept with it.
 *
 * Headers are only recognised outside multi-line arrays and strings. A fleet
 * server defined as a dotted key or inline table (`[mcp_servers]` +
 * `fleet = {…}`, or a root `mcp_servers.fleet.command = …`) can't be cut out
 * line-wise, so it is refused with a clear message instead of producing a
 * duplicate definition Codex would reject.
 */
export function mergeCodexConfig(existingRaw: string | undefined, entry: McpEntry): string {
  const raw = (existingRaw ?? "").replace(/^﻿/, "");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const kept: string[] = [];
  let pending: string[] = [];
  let table: string[] = [];
  let skipping = false;
  const scan: ScanState = { depth: 0 };
  /** Re-attaches comments that trailed a cut fleet table (they introduce whatever follows), with one blank line of separation. */
  const keepTrailingComments = () => {
    const first = pending.findIndex((l) => l.trim().startsWith("#"));
    if (first === -1) return;
    if (kept.length > 0 && kept[kept.length - 1]!.trim() !== "") kept.push("");
    kept.push(...pending.slice(first));
  };

  for (const line of raw.split(/\r?\n/)) {
    const header = scan.depth === 0 && !scan.multiline ? HEADER_LINE.exec(line) : null;
    if (header) {
      table = keyPath(header[1]!);
      const fleet = isFleetPath(table);
      if (skipping && !fleet) keepTrailingComments();
      pending = [];
      skipping = fleet;
      if (!skipping) kept.push(line);
      continue;
    }
    if (scan.depth === 0 && !scan.multiline) {
      const key = KEY_LINE.exec(line);
      if (key && !skipping && isFleetPath([...table, ...keyPath(key[1]!)])) {
        throw new Error(
          `.codex/config.toml defines the fleet MCP server as a dotted key or inline table (\`${line.trim()}\`), which fleet can't rewrite safely — ` +
            `remove that definition (or rewrite it as a [${FLEET_TABLE}] table) and run again.`,
        );
      }
    }
    const wasInValue = scan.depth > 0 || scan.multiline !== undefined;
    scanValueLine(line, scan);
    if (!skipping) {
      kept.push(line);
    } else if (!wasInValue && /^\s*(#.*)?$/.test(line)) {
      pending.push(line);
    } else {
      pending = [];
    }
  }
  if (skipping) keepTrailingComments();

  const body = kept.join(eol).replace(/\s+$/, "");
  const fleetTable = renderCodexFleetTable(entry).split("\n").join(eol);
  return `${body ? `${body}${eol}${eol}` : ""}${fleetTable}${eol}`;
}

/**
 * Codex: `.agents/skills/<name>/SKILL.md` (same SKILL.md format as Claude),
 * `[mcp_servers.<name>]` in `.codex/config.toml`. The entry's `node` command
 * resolves as a real executable on every platform, so Codex's shell-less
 * spawn needs no Windows special case, and its bootstrap finds the launcher
 * from any subdirectory Codex is started in.
 */
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
