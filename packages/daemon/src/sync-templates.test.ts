import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { LAUNCHER_BOOTSTRAP } from "@fleet/mcp/stamp";
import { makeProject } from "./test-support.ts";
import { issueFormFiles, syncTemplates } from "./sync-templates.ts";

const OPTS = { port: 4400 };

describe("syncTemplates", () => {
  const repoDirs: string[] = [];

  afterEach(() => {
    for (const dir of repoDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stamps the skill and the generic + epic issue forms into a project with no fleet.yaml", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "fleet-sync-"));
    repoDirs.push(repoPath);

    await syncTemplates([makeProject({ repoPath })], OPTS);

    expect(existsSync(join(repoPath, ".claude", "skills", "fleet-backlog", "SKILL.md"))).toBe(true);
    expect(existsSync(join(repoPath, ".agents"))).toBe(false);
    const mcp = JSON.parse(readFileSync(join(repoPath, ".mcp.json"), "utf8")) as { mcpServers: { fleet: { args: string[]; env: Record<string, string> } } };
    // Committed files name no path; this machine's paths live in the repo's gitignored config.
    expect(mcp.mcpServers.fleet.env).toEqual({ FLEET_PROJECT: "alpha" });
    expect(mcp.mcpServers.fleet.args).toEqual(["-e", LAUNCHER_BOOTSTRAP]);
    expect(existsSync(join(repoPath, ".fleet-mcp", "launch.mjs"))).toBe(true);
    const repoConfig = JSON.parse(readFileSync(join(repoPath, "fleet.config.json"), "utf8")) as { fleetDir: string; dashboardPort: number; projects: { name: string }[] };
    expect(repoConfig.dashboardPort).toBe(4400);
    expect(repoConfig.projects.map((p) => p.name)).toEqual(["alpha"]);
    expect(existsSync(join(repoConfig.fleetDir, "packages", "mcp", "package.json"))).toBe(true);
    expect(readFileSync(join(repoPath, ".gitignore"), "utf8")).toContain("fleet.config.json");

    const issueTemplateDir = join(repoPath, ".github", "ISSUE_TEMPLATE");
    expect(readdirSync(issueTemplateDir).sort()).toEqual(["01-fleet-task.yml", "02-fleet-epic.yml"]);

    const taskForm = readFileSync(join(issueTemplateDir, "01-fleet-task.yml"), "utf8");
    expect(taskForm).toContain("name: Fleet task");
    expect(taskForm).toContain("id: problem");

    const epicForm = readFileSync(join(issueTemplateDir, "02-fleet-epic.yml"), "utf8");
    expect(epicForm).toContain("name: Fleet epic");
    expect(epicForm).toContain('labels: ["fleet:plan", "fleet:ready"]');
  });

  it("adds a task form per non-default fleet.yaml profile, in fleet.yaml's declared order", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "fleet-sync-"));
    repoDirs.push(repoPath);
    writeFileSync(
      join(repoPath, "fleet.yaml"),
      [
        "setup:",
        "  default:",
        "    - name: install",
        "      run: pnpm install",
        "  dashboard:",
        "    setup:",
        "      - name: install",
        "        run: pnpm install",
        "  daemon:",
        "    setup:",
        "      - name: install",
        "        run: pnpm install",
      ].join("\n"),
    );

    await syncTemplates([makeProject({ repoPath })], OPTS);

    const issueTemplateDir = join(repoPath, ".github", "ISSUE_TEMPLATE");
    expect(readdirSync(issueTemplateDir).sort()).toEqual([
      "01-fleet-task.yml",
      "02-fleet-task-dashboard.yml",
      "03-fleet-task-daemon.yml",
      "04-fleet-epic.yml",
    ]);

    const dashboardForm = readFileSync(join(issueTemplateDir, "02-fleet-task-dashboard.yml"), "utf8");
    expect(dashboardForm).toContain('name: "Fleet task: Dashboard"');
    expect(dashboardForm).toContain('labels: ["fleet:ready", "fleet:type:dashboard"]');

    // every generated form must be valid YAML — GitHub silently drops invalid
    // forms from the New Issue chooser (the type-form name contains ": ")
    for (const file of readdirSync(issueTemplateDir)) {
      const parsed = parseYaml(readFileSync(join(issueTemplateDir, file), "utf8"));
      expect(parsed, file).toHaveProperty("name");
      expect(parsed, file).toHaveProperty("body");
    }
  });

  it("prunes forms left over from a profile that was renamed or removed since the last run", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "fleet-sync-"));
    repoDirs.push(repoPath);
    const fleetYamlPath = join(repoPath, "fleet.yaml");
    const project = makeProject({ repoPath });

    writeFileSync(
      fleetYamlPath,
      [
        "setup:",
        "  default:",
        "    - name: install",
        "      run: pnpm install",
        "  dashboard:",
        "    setup:",
        "      - name: install",
        "        run: pnpm install",
        "  daemon:",
        "    setup:",
        "      - name: install",
        "        run: pnpm install",
      ].join("\n"),
    );
    await syncTemplates([project], OPTS);
    const issueTemplateDir = join(repoPath, ".github", "ISSUE_TEMPLATE");
    expect(readdirSync(issueTemplateDir).sort()).toEqual([
      "01-fleet-task.yml",
      "02-fleet-task-dashboard.yml",
      "03-fleet-task-daemon.yml",
      "04-fleet-epic.yml",
    ]);

    // A repo maintainer's own, non-generated form must survive the reconcile.
    writeFileSync(join(issueTemplateDir, "05-bug-report.yml"), "name: Bug report\n");

    // "daemon" is renamed to "backend"; "dashboard" is dropped entirely.
    writeFileSync(
      fleetYamlPath,
      ["setup:", "  default:", "    - name: install", "      run: pnpm install", "  backend:", "    setup:", "      - name: install", "        run: pnpm install"].join("\n"),
    );
    await syncTemplates([project], OPTS);

    expect(readdirSync(issueTemplateDir).sort()).toEqual([
      "01-fleet-task.yml",
      "02-fleet-task-backend.yml",
      "03-fleet-epic.yml",
      "05-bug-report.yml",
    ]);
  });

  it("falls back to just the generic + epic forms for a list-form fleet.yaml", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "fleet-sync-"));
    repoDirs.push(repoPath);
    writeFileSync(join(repoPath, "fleet.yaml"), "setup:\n  - name: install\n    run: pnpm install\n");

    await syncTemplates([makeProject({ repoPath })], OPTS);

    const issueTemplateDir = join(repoPath, ".github", "ISSUE_TEMPLATE");
    expect(readdirSync(issueTemplateDir).sort()).toEqual(["01-fleet-task.yml", "02-fleet-epic.yml"]);
  });

  it("fails open to the generic + epic forms when fleet.yaml is malformed", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "fleet-sync-"));
    repoDirs.push(repoPath);
    writeFileSync(join(repoPath, "fleet.yaml"), "setup: not-a-list-or-map\n");

    await expect(syncTemplates([makeProject({ repoPath })], OPTS)).resolves.toBeUndefined();

    const issueTemplateDir = join(repoPath, ".github", "ISSUE_TEMPLATE");
    expect(readdirSync(issueTemplateDir).sort()).toEqual(["01-fleet-task.yml", "02-fleet-epic.yml"]);
  });

  it("overwrites previously stamped issue forms on rerun", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "fleet-sync-"));
    repoDirs.push(repoPath);
    const project = makeProject({ repoPath });

    await syncTemplates([project], OPTS);
    const destPath = join(repoPath, ".github", "ISSUE_TEMPLATE", "01-fleet-task.yml");
    const first = readFileSync(destPath, "utf8");

    await syncTemplates([project], OPTS);
    const second = readFileSync(destPath, "utf8");

    expect(second).toEqual(first);
  });

  it("skips a project whose repoPath does not exist", async () => {
    await expect(syncTemplates([makeProject({ repoPath: join(tmpdir(), "fleet-sync-missing-project") })], OPTS)).resolves.toBeUndefined();
  });
});

describe("issueFormFiles", () => {
  it("generates only the generic task and epic forms when there is no fleet.yaml", () => {
    const files = issueFormFiles(undefined);
    expect(files.map((f) => f.fileName)).toEqual(["01-fleet-task.yml", "02-fleet-epic.yml"]);
  });

  it("numbers a type form per non-default profile, ahead of the epic form", () => {
    const files = issueFormFiles({
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        frontend: [{ name: "install", run: "pnpm install" }],
        backend: [{ name: "install", run: "pnpm install" }],
      },
    });
    expect(files.map((f) => f.fileName)).toEqual([
      "01-fleet-task.yml",
      "02-fleet-task-frontend.yml",
      "03-fleet-task-backend.yml",
      "04-fleet-epic.yml",
    ]);
    expect(files[1]?.content).toContain('labels: ["fleet:ready", "fleet:type:frontend"]');
  });

  it("ignores a list-form spec (no profiles to label)", () => {
    const files = issueFormFiles({ setup: [{ name: "install", run: "pnpm install" }] });
    expect(files.map((f) => f.fileName)).toEqual(["01-fleet-task.yml", "02-fleet-epic.yml"]);
  });
});
