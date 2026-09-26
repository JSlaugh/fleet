import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invocationDir, parseInitArgs, runInit } from "./init.ts";
import { FLEET_DIR, LAUNCHER_BOOTSTRAP } from "./stamp/index.ts";

describe("parseInitArgs", () => {
  it("parses every flag and ignores a leading `init`", () => {
    const args = parseInitArgs(["init", "--path", "/r", "--repo", "o/n", "--project", "p", "--agents", "codex, claude", "--config", "/c.json", "--dashboard-port", "4410"]);
    expect(args).toMatchObject({ repo: "o/n", project: "p", agents: ["codex", "claude"], pathGiven: true, dashboardPort: 4410, help: false });
    expect(args.config?.endsWith("c.json")).toBe(true);
    expect(args.path.endsWith("r")).toBe(true);
  });

  it("resolves relative --path and --config against the invocation directory, not packages/mcp", () => {
    const args = parseInitArgs(["--path", "repo", "--config", "cfg/fleet.config.json"], join(tmpdir(), "where-i-ran-pnpm"));
    expect(args.path).toBe(join(tmpdir(), "where-i-ran-pnpm", "repo"));
    expect(args.config).toBe(join(tmpdir(), "where-i-ran-pnpm", "cfg", "fleet.config.json"));
    expect(parseInitArgs([], "/somewhere").path).toBe("/somewhere");
  });

  it("prefers INIT_CWD as the invocation directory", () => {
    expect(invocationDir({ INIT_CWD: "/target" })).toBe("/target");
  });

  it("rejects an unknown agent, a malformed repo, and an unknown flag", () => {
    expect(() => parseInitArgs(["--agents", "cursor"])).toThrow(/unknown agent/);
    expect(() => parseInitArgs(["--repo", "nope"])).toThrow(/owner\/name/);
    expect(() => parseInitArgs(["--bogus"])).toThrow(/unknown argument/);
  });
});

describe("runInit", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-init-"));
    dirs.push(dir);
    return dir;
  };
  const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const fleetDirSlashes = FLEET_DIR.replace(/\\/g, "/");

  it("with --repo and no config, writes the gitignored repo config and stamps path-free committed files", () => {
    const repo = tempDir();
    const lines: string[] = [];
    runInit(parseInitArgs(["--path", repo, "--repo", "acme/widgets", "--agents", "codex"]), (l) => lines.push(l));

    expect(readJson(join(repo, "fleet.config.json"))).toEqual({
      fleetDir: fleetDirSlashes,
      projects: [{ name: "widgets", githubRepo: "acme/widgets", agents: ["codex"] }],
    });
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("fleet.config.json\n");
    expect(existsSync(join(repo, ".fleet-mcp", "launch.mjs"))).toBe(true);
    expect(existsSync(join(repo, ".agents", "skills", "fleet-backlog", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    const toml = readFileSync(join(repo, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('env = { FLEET_PROJECT = "widgets" }');
    expect(toml).not.toContain(fleetDirSlashes);
    expect(lines.join("\n")).toMatch(/done — stamped widgets/);
    expect(lines.join("\n")).toMatch(/--dashboard-port/);
  });

  it("defaults to claude when neither --agents nor a config says otherwise", () => {
    const repo = tempDir();
    runInit(parseInitArgs(["--path", repo, "--repo", "acme/widgets"]), () => {});
    expect(readJson(join(repo, ".mcp.json")).mcpServers.fleet).toEqual({
      command: "node",
      args: ["-e", LAUNCHER_BOOTSTRAP],
      env: { FLEET_PROJECT: "widgets" },
    });
    expect(existsSync(join(repo, ".codex"))).toBe(false);
  });

  it("records an explicit --dashboard-port in the repo config", () => {
    const repo = tempDir();
    runInit(parseInitArgs(["--path", repo, "--repo", "acme/widgets", "--dashboard-port", "4410"]), () => {});
    expect(readJson(join(repo, "fleet.config.json")).dashboardPort).toBe(4410);
  });

  it("reads the project from a config found upward, honouring its agents, and implies 4400 for a daemon config", () => {
    const root = tempDir();
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeFileSync(
      join(root, "fleet.config.json"),
      JSON.stringify({ worktreeRoot: "/wt", projects: [{ name: "a", githubRepo: "o/a", agents: ["claude", "codex"] }, { name: "b", githubRepo: "o/b" }] }),
    );

    runInit(parseInitArgs(["--path", repo, "--project", "a"]), () => {});

    expect(existsSync(join(repo, ".claude", "skills", "fleet-backlog", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".agents", "skills", "fleet-backlog", "SKILL.md"))).toBe(true);
    expect(readJson(join(repo, "fleet.config.json"))).toEqual({
      fleetDir: fleetDirSlashes,
      dashboardPort: 4400,
      projects: [{ name: "a", githubRepo: "o/a", agents: ["claude", "codex"] }],
    });
  });

  it("is idempotent: a second run finds the repo's own config and changes nothing — agents included", () => {
    const repo = tempDir();
    runInit(parseInitArgs(["--path", repo, "--repo", "acme/widgets", "--agents", "claude,codex"]), () => {});
    const before = readFileSync(join(repo, "fleet.config.json"), "utf8");
    runInit(parseInitArgs(["--path", repo]), () => {});
    expect(readFileSync(join(repo, "fleet.config.json"), "utf8")).toBe(before);
    expect(readJson(join(repo, "fleet.config.json")).projects[0].agents).toEqual(["claude", "codex"]);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("fleet.config.json\n");
  });

  it("demands --project when the config lists several and none matches", () => {
    const root = tempDir();
    writeFileSync(join(root, "fleet.config.json"), JSON.stringify({ projects: [{ name: "a", githubRepo: "o/a" }, { name: "b", githubRepo: "o/b" }] }));
    expect(() => runInit(parseInitArgs(["--path", root]), () => {})).toThrow(/pass --project/);
  });

  it("refuses to stamp the fleet checkout when --path was defaulted (pnpm --dir reports it as the invocation dir)", () => {
    expect(() => runInit(parseInitArgs(["--repo", "acme/widgets"], FLEET_DIR), () => {})).toThrow(/Pass --path/);
  });

  it("fails clearly with no config and no --repo", () => {
    const root = tempDir();
    expect(() => runInit(parseInitArgs(["--path", root]), () => {})).toThrow(/--repo owner\/name/);
  });
});
