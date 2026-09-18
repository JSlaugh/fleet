import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseInitArgs, runInit } from "./init.ts";

describe("parseInitArgs", () => {
  it("parses every flag and ignores a leading `init`", () => {
    const args = parseInitArgs(["init", "--path", "/r", "--repo", "o/n", "--project", "p", "--agents", "codex, claude", "--config", "/c.json"]);
    expect(args).toMatchObject({ repo: "o/n", project: "p", agents: ["codex", "claude"], config: "/c.json", help: false });
    expect(args.path.endsWith("r")).toBe(true);
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

  it("with --repo and no config, writes a projects-only config then stamps for codex by default", () => {
    const repo = mkdtempSync(join(tmpdir(), "fleet-init-"));
    dirs.push(repo);
    const lines: string[] = [];
    runInit(parseInitArgs(["--path", repo, "--repo", "acme/widgets"]), (l) => lines.push(l));

    const config = JSON.parse(readFileSync(join(repo, "fleet.config.json"), "utf8"));
    expect(config).toEqual({ agents: ["codex"], projects: [{ name: "widgets", githubRepo: "acme/widgets" }] });
    expect(existsSync(join(repo, ".agents", "skills", "fleet-backlog", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    const toml = readFileSync(join(repo, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('FLEET_PROJECT = "widgets"');
    expect(toml).toContain(`FLEET_CONFIG = "${join(repo, "fleet.config.json").replace(/\\/g, "/")}"`);
    expect(toml).not.toContain("FLEET_URL");
    expect(lines.join("\n")).toMatch(/done — stamped widgets/);
  });

  it("uses an existing config found upward from the repo, honouring the project's own agents", () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-init-"));
    dirs.push(root);
    const repo = join(root, "repo");
    writeFileSync(join(root, "fleet.config.json"), JSON.stringify({ dashboardPort: 4400, projects: [{ name: "a", githubRepo: "o/a", agents: ["claude", "codex"] }, { name: "b", githubRepo: "o/b" }] }));
    rmSync(repo, { force: true, recursive: true });
    mkdirSync(repo);

    runInit(parseInitArgs(["--path", repo, "--project", "a"]), () => {});

    expect(existsSync(join(repo, ".claude", "skills", "fleet-backlog", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".agents", "skills", "fleet-backlog", "SKILL.md"))).toBe(true);
    const mcp = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.fleet.env).toEqual({ FLEET_PROJECT: "a", FLEET_CONFIG: join(root, "fleet.config.json").replace(/\\/g, "/"), FLEET_URL: "http://localhost:4400" });
  });

  it("demands --project when the config lists several and none matches", () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-init-"));
    dirs.push(root);
    writeFileSync(join(root, "fleet.config.json"), JSON.stringify({ projects: [{ name: "a", githubRepo: "o/a" }, { name: "b", githubRepo: "o/b" }] }));
    expect(() => runInit(parseInitArgs(["--path", root]), () => {})).toThrow(/pass --project/);
  });

  it("fails clearly with no config and no --repo", () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-init-"));
    dirs.push(root);
    expect(() => runInit(parseInitArgs(["--path", root]), () => {})).toThrow(/--repo owner\/name/);
  });
});
