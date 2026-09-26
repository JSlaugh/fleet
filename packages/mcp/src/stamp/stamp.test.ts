import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexEntry } from "./codex.ts";
import { FLEET_DIR, buildFleetEntry, mergeCodexConfig, mergeMcpConfig, renderCodexFleetTable, stampProject, type McpEntry } from "./index.ts";

const ENTRY: McpEntry = {
  command: "pnpm",
  args: ["--dir", "C:/Users/j/github/fleet", "--filter", "@fleet/mcp", "start"],
  env: { FLEET_PROJECT: "example", FLEET_CONFIG: "C:/Users/j/github/fleet/fleet.config.json", FLEET_URL: "http://localhost:4400" },
};

describe("mergeMcpConfig", () => {
  it("creates a fresh file with only the fleet entry when none exists", () => {
    expect(JSON.parse(mergeMcpConfig(undefined, ENTRY))).toEqual({ mcpServers: { fleet: ENTRY } });
  });

  it("replaces only the fleet entry, preserving other servers and top-level keys", () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: "node", args: ["other-server.js"] }, fleet: { command: "stale", args: [] } },
      someOtherTopLevelKey: true,
    });
    expect(JSON.parse(mergeMcpConfig(existing, ENTRY))).toEqual({
      mcpServers: { other: { command: "node", args: ["other-server.js"] }, fleet: ENTRY },
      someOtherTopLevelKey: true,
    });
  });

  it("tolerates a UTF-8 BOM-prefixed existing file", () => {
    const existing = `\uFEFF${JSON.stringify({ mcpServers: { other: { command: "node" } } })}`;
    expect(JSON.parse(mergeMcpConfig(existing, ENTRY))).toEqual({ mcpServers: { other: { command: "node" }, fleet: ENTRY } });
  });

  it("throws a clear error on malformed existing JSON", () => {
    expect(() => mergeMcpConfig("{ not valid json", ENTRY)).toThrow(/not valid JSON/);
  });

  it("adds an mcpServers object when the existing file lacks one", () => {
    expect(JSON.parse(mergeMcpConfig(JSON.stringify({ unrelated: "value" }), ENTRY))).toEqual({ unrelated: "value", mcpServers: { fleet: ENTRY } });
  });

  it("is idempotent", () => {
    const first = mergeMcpConfig(undefined, ENTRY);
    expect(mergeMcpConfig(first, ENTRY)).toBe(first);
  });
});

describe("renderCodexFleetTable", () => {
  it("renders command, args and an inline env table with TOML-safe strings", () => {
    expect(renderCodexFleetTable(ENTRY)).toBe(
      [
        "[mcp_servers.fleet]",
        'command = "pnpm"',
        'args = ["--dir", "C:/Users/j/github/fleet", "--filter", "@fleet/mcp", "start"]',
        'env = { FLEET_PROJECT = "example", FLEET_CONFIG = "C:/Users/j/github/fleet/fleet.config.json", FLEET_URL = "http://localhost:4400" }',
      ].join("\n"),
    );
  });

  it("escapes backslashes and quotes", () => {
    const table = renderCodexFleetTable({ command: "c", args: ['a"b'], env: { P: "C:\\x" } });
    expect(table).toContain('args = ["a\\"b"]');
    expect(table).toContain('P = "C:\\\\x"');
  });
});

describe("mergeCodexConfig", () => {
  it("creates a fresh file with only the fleet table when none exists", () => {
    expect(mergeCodexConfig(undefined, ENTRY)).toBe(`${renderCodexFleetTable(ENTRY)}\n`);
  });

  it("preserves every other table, comment and blank line verbatim, and replaces a stale fleet table", () => {
    const existing = [
      "# my codex config",
      'model = "o3"',
      "",
      "[mcp_servers.other]",
      'command = "node"',
      "",
      "[mcp_servers.fleet]",
      'command = "stale"',
      "",
      "[mcp_servers.fleet.env]",
      'FLEET_PROJECT = "old"',
      "",
      "[projects.\"/x\"]",
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const merged = mergeCodexConfig(existing, ENTRY);
    expect(merged).toBe(
      [
        "# my codex config",
        'model = "o3"',
        "",
        "[mcp_servers.other]",
        'command = "node"',
        "",
        "[projects.\"/x\"]",
        'trust_level = "trusted"',
        "",
        renderCodexFleetTable(ENTRY),
        "",
      ].join("\n"),
    );
    expect(merged).not.toContain("stale");
    expect(merged).not.toContain('"old"');
  });

  it("tolerates a BOM and keeps CRLF line endings, so a sync on Windows is not a whole-file diff", () => {
    const existing = `\uFEFF[mcp_servers.other]\r\ncommand = "node"\r\n`;
    const merged = mergeCodexConfig(existing, ENTRY);
    expect(merged.startsWith("[mcp_servers.other]\r\ncommand = \"node\"\r\n\r\n[mcp_servers.fleet]\r\n")).toBe(true);
    expect(merged.replace(/\r\n/g, "")).not.toContain("\n");
    expect(mergeCodexConfig(merged, ENTRY)).toBe(merged);
  });

  it("recognises a fleet table written with quoted keys", () => {
    for (const header of ['[mcp_servers."fleet"]', "[mcp_servers.'fleet']", '[ "mcp_servers" . fleet ]', '[mcp_servers."fleet".env]']) {
      const merged = mergeCodexConfig(`${header}\ncommand = "stale"\n`, ENTRY);
      expect(merged).not.toContain("stale");
      expect(merged.match(/\[mcp_servers\.fleet\]/g)).toHaveLength(1);
    }
  });

  it("does not mistake a line of a multi-line array or string for a table header", () => {
    const existing = [
      "[mcp_servers.fleet]",
      "args = [",
      '  ["a", "b"],',
      '  ["c"]',
      "]",
      "description = '''",
      "[not.a.header]",
      "'''",
      "",
      "[mcp_servers.other]",
      'command = "node"',
    ].join("\n");
    const merged = mergeCodexConfig(existing, ENTRY);
    expect(merged).not.toContain('"a"');
    expect(merged).not.toContain("not.a.header");
    expect(merged.startsWith('[mcp_servers.other]\ncommand = "node"\n\n[mcp_servers.fleet]')).toBe(true);
  });

  it("keeps comments sitting directly above the table after the fleet table", () => {
    const existing = ["[mcp_servers.fleet]", 'command = "stale"', "", "# my other server", "[mcp_servers.other]", 'command = "node"'].join("\n");
    expect(mergeCodexConfig(existing, ENTRY)).toContain("# my other server\n[mcp_servers.other]");
  });

  it("refuses a fleet server defined as a dotted key or inline table rather than emitting a duplicate", () => {
    expect(() => mergeCodexConfig('[mcp_servers]\nfleet = { command = "x" }\n', ENTRY)).toThrow(/can't rewrite safely/);
    expect(() => mergeCodexConfig('mcp_servers.fleet.command = "x"\n', ENTRY)).toThrow(/can't rewrite safely/);
    expect(() => mergeCodexConfig('[mcp_servers]\nother = { command = "x" }\n', ENTRY)).not.toThrow();
  });

  it("is idempotent", () => {
    const first = mergeCodexConfig('[mcp_servers.other]\ncommand = "node"\n', ENTRY);
    expect(mergeCodexConfig(first, ENTRY)).toBe(first);
  });
});

describe("codexEntry", () => {
  it("routes a bare command through cmd /c on Windows, where Codex's direct spawn can't resolve a .cmd shim", () => {
    expect(codexEntry(ENTRY, "win32")).toEqual({ ...ENTRY, command: "cmd", args: ["/c", "pnpm", ...ENTRY.args] });
  });

  it("leaves the entry alone elsewhere, or when the command is already a path or has an extension", () => {
    expect(codexEntry(ENTRY, "linux")).toBe(ENTRY);
    expect(codexEntry({ ...ENTRY, command: "pnpm.cmd" }, "win32").command).toBe("pnpm.cmd");
    expect(codexEntry({ ...ENTRY, command: "C:/tools/pnpm" }, "win32").command).toBe("C:/tools/pnpm");
  });
});

describe("stampProject", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes each agent's skill copy and registration from one skill template, stamping a repeated agent once", () => {
    const repo = mkdtempSync(join(tmpdir(), "fleet-stamp-"));
    dirs.push(repo);
    const result = stampProject(repo, ["codex", "claude", "codex"], ENTRY, "# skill\n");

    expect(readFileSync(join(repo, ".claude", "skills", "fleet-backlog", "SKILL.md"), "utf8")).toBe("# skill\n");
    expect(readFileSync(join(repo, ".agents", "skills", "fleet-backlog", "SKILL.md"), "utf8")).toBe("# skill\n");
    expect(JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { fleet: ENTRY } });
    expect(readFileSync(join(repo, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.fleet]");
    expect(result.written).toHaveLength(4);
    expect(result.notes.join("\n")).toMatch(/trusted directory/);
  });

  it("stamps only the requested agent", () => {
    const repo = mkdtempSync(join(tmpdir(), "fleet-stamp-"));
    dirs.push(repo);
    stampProject(repo, ["claude"], ENTRY, "# skill\n");
    expect(existsSync(join(repo, ".agents"))).toBe(false);
    expect(existsSync(join(repo, ".codex"))).toBe(false);
  });

  it("merges into an existing registration rather than replacing it", () => {
    const repo = mkdtempSync(join(tmpdir(), "fleet-stamp-"));
    dirs.push(repo);
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "node" } } }));
    stampProject(repo, ["claude"], ENTRY, "# skill\n");
    expect(JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")).mcpServers.other).toEqual({ command: "node" });
  });
});

describe("buildFleetEntry", () => {
  it("points at this checkout with FLEET_PROJECT and FLEET_CONFIG, adding FLEET_URL only when a daemon is known", () => {
    const withDaemon = buildFleetEntry({ project: "p", configPath: "/w/fleet.config.json", daemonUrl: "http://localhost:4400" });
    expect(withDaemon.command).toBe("pnpm");
    expect(withDaemon.args.slice(2)).toEqual(["--filter", "@fleet/mcp", "start"]);
    expect(withDaemon.args[1]).toBe(FLEET_DIR.replace(/\\/g, "/"));
    expect(withDaemon.args[1]).not.toContain("{{");
    expect(withDaemon.env).toEqual({ FLEET_PROJECT: "p", FLEET_CONFIG: "/w/fleet.config.json", FLEET_URL: "http://localhost:4400" });

    const without = buildFleetEntry({ project: "p", configPath: "C:\\w\\fleet.config.json" });
    expect(without.env).toEqual({ FLEET_PROJECT: "p", FLEET_CONFIG: "C:/w/fleet.config.json" });
  });
});
