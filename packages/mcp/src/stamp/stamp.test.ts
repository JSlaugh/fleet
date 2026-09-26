import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FLEET_DIR,
  LAUNCHER_PATH,
  buildFleetEntry,
  claudeEntry,
  ensureIgnored,
  mergeCodexConfig,
  mergeMcpConfig,
  renderCodexFleetTable,
  stampProject,
  writeRepoConfig,
  type McpEntry,
} from "./index.ts";

const ENTRY: McpEntry = { command: "node", args: [".fleet-mcp/launch.mjs"], env: { FLEET_PROJECT: "example" } };

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
        'command = "node"',
        'args = [".fleet-mcp/launch.mjs"]',
        'env = { FLEET_PROJECT = "example" }',
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

describe("stampProject", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempRepo = () => {
    const repo = mkdtempSync(join(tmpdir(), "fleet-stamp-"));
    dirs.push(repo);
    return repo;
  };

  it("writes the launcher once plus each agent's skill copy and registration, stamping a repeated agent once", () => {
    const repo = tempRepo();
    const result = stampProject(repo, ["codex", "claude", "codex"], ENTRY, "# skill\n", { launcherSource: "// launcher\n" });

    expect(readFileSync(join(repo, ".fleet-mcp", "launch.mjs"), "utf8")).toBe("// launcher\n");
    expect(readFileSync(join(repo, ".claude", "skills", "fleet-backlog", "SKILL.md"), "utf8")).toBe("# skill\n");
    expect(readFileSync(join(repo, ".agents", "skills", "fleet-backlog", "SKILL.md"), "utf8")).toBe("# skill\n");
    expect(JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { fleet: claudeEntry(ENTRY) } });
    expect(readFileSync(join(repo, ".codex", "config.toml"), "utf8")).toContain('args = [".fleet-mcp/launch.mjs"]');
    expect(result.written).toHaveLength(5);
    expect(result.notes.join("\n")).toMatch(/trusted directory/);
  });

  it("stamps only the requested agent", () => {
    const repo = tempRepo();
    stampProject(repo, ["claude"], ENTRY, "# skill\n");
    expect(existsSync(join(repo, ".agents"))).toBe(false);
    expect(existsSync(join(repo, ".codex"))).toBe(false);
  });

  it("merges into an existing registration rather than replacing it", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "node" } } }));
    stampProject(repo, ["claude"], ENTRY, "# skill\n");
    expect(JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")).mcpServers.other).toEqual({ command: "node" });
  });

  it("puts every machine path in the gitignored repo config, never in a committed file", () => {
    const repo = tempRepo();
    const fleetDir = join(tmpdir(), "somewhere", "fleet");
    stampProject(repo, ["claude", "codex"], ENTRY, "# skill\n", {
      repoConfig: { fleetDir, dashboardPort: 4400, project: { name: "example", githubRepo: "acme/example" } },
    });

    expect(JSON.parse(readFileSync(join(repo, "fleet.config.json"), "utf8"))).toEqual({
      fleetDir: fleetDir.replace(/\\/g, "/"),
      dashboardPort: 4400,
      projects: [{ name: "example", githubRepo: "acme/example" }],
    });
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("fleet.config.json\n");
    for (const committed of [".mcp.json", join(".codex", "config.toml"), join(".fleet-mcp", "launch.mjs")]) {
      const text = readFileSync(join(repo, committed), "utf8");
      expect(text).not.toContain(tmpdir().replace(/\\/g, "/"));
      expect(text).not.toContain(tmpdir());
    }
  });
});

describe("writeRepoConfig", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("merges into an existing config: refreshes fleetDir/port, upserts the project, keeps other keys and projects", () => {
    const repo = mkdtempSync(join(tmpdir(), "fleet-repocfg-"));
    dirs.push(repo);
    writeFileSync(join(repo, "fleet.config.json"), JSON.stringify({ fleetDir: "old", custom: true, projects: [{ name: "other", githubRepo: "o/other" }, { name: "example", githubRepo: "o/stale" }] }));
    writeFileSync(join(repo, ".gitignore"), "node_modules/\r\n/fleet.config.json\r\n");

    const written = writeRepoConfig(repo, { fleetDir: "/opt/fleet", project: { name: "example", githubRepo: "acme/example" } });

    expect(JSON.parse(readFileSync(join(repo, "fleet.config.json"), "utf8"))).toEqual({
      fleetDir: "/opt/fleet",
      custom: true,
      projects: [{ name: "other", githubRepo: "o/other" }, { name: "example", githubRepo: "acme/example" }],
    });
    expect(written).toEqual([join(repo, "fleet.config.json")]);
  });

  it("writes nothing into the fleet checkout itself, whose daemon config already sits there", () => {
    expect(writeRepoConfig(FLEET_DIR, { fleetDir: FLEET_DIR, project: { name: "fleet", githubRepo: "acme/fleet" } })).toEqual([]);
  });
});

describe("ensureIgnored", () => {
  it("appends once, keeping the file's line endings and a missing trailing newline in mind", () => {
    const repo = mkdtempSync(join(tmpdir(), "fleet-ignore-"));
    try {
      writeFileSync(join(repo, ".gitignore"), "dist/\r\nnode_modules/");
      ensureIgnored(repo, "fleet.config.json");
      expect(ensureIgnored(repo, "fleet.config.json")).toEqual([]);
      expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("dist/\r\nnode_modules/\r\nfleet.config.json\r\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("buildFleetEntry", () => {
  it("names no path: it runs the stamped launcher with just the project name", () => {
    expect(buildFleetEntry({ project: "p" })).toEqual({ command: "node", args: [LAUNCHER_PATH], env: { FLEET_PROJECT: "p" } });
  });

  it("addresses the launcher from the project root for Claude, via its env-var expansion", () => {
    expect(claudeEntry(buildFleetEntry({ project: "p" })).args).toEqual(["${CLAUDE_PROJECT_DIR:-.}/.fleet-mcp/launch.mjs"]);
  });
});
