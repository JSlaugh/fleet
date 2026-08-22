import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { makeProject } from "./test-support.ts";
import { issueFormFiles, mergeMcpConfig, syncTemplates } from "./sync-templates.ts";

const FLEET_ENTRY = {
  command: "pnpm",
  args: ["--dir", "C:/Users/j/github/fleet", "--filter", "@fleet/mcp", "start"],
  env: { FLEET_PROJECT: "example", FLEET_URL: "http://localhost:4400" },
};

describe("mergeMcpConfig", () => {
  it("creates a fresh file with only the fleet entry when none exists", () => {
    const result = mergeMcpConfig(undefined, FLEET_ENTRY);
    expect(JSON.parse(result)).toEqual({ mcpServers: { fleet: FLEET_ENTRY } });
  });

  it("replaces only the fleet entry, preserving other servers and top-level keys", () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { command: "node", args: ["other-server.js"] },
        fleet: { command: "stale", args: [] },
      },
      someOtherTopLevelKey: true,
    });
    const result = mergeMcpConfig(existing, FLEET_ENTRY);
    expect(JSON.parse(result)).toEqual({
      mcpServers: {
        other: { command: "node", args: ["other-server.js"] },
        fleet: FLEET_ENTRY,
      },
      someOtherTopLevelKey: true,
    });
  });

  it("tolerates a UTF-8 BOM-prefixed existing file", () => {
    const bom = String.fromCharCode(0xfeff);
    const existing = `${bom}${JSON.stringify({ mcpServers: { other: { command: "node" } } })}`;
    const result = mergeMcpConfig(existing, FLEET_ENTRY);
    expect(JSON.parse(result)).toEqual({
      mcpServers: { other: { command: "node" }, fleet: FLEET_ENTRY },
    });
  });

  it("throws a clear error on malformed existing JSON", () => {
    expect(() => mergeMcpConfig("{ not valid json", FLEET_ENTRY)).toThrow(/not valid JSON/);
  });

  it("adds an mcpServers object when the existing file lacks one", () => {
    const existing = JSON.stringify({ unrelated: "value" });
    const result = mergeMcpConfig(existing, FLEET_ENTRY);
    expect(JSON.parse(result)).toEqual({ unrelated: "value", mcpServers: { fleet: FLEET_ENTRY } });
  });

  it("is idempotent: merging the same entry twice produces the same result", () => {
    const first = mergeMcpConfig(undefined, FLEET_ENTRY);
    const second = mergeMcpConfig(first, FLEET_ENTRY);
    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });
});

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

    await syncTemplates([makeProject({ repoPath })]);

    expect(existsSync(join(repoPath, ".claude", "skills", "fleet-backlog", "SKILL.md"))).toBe(true);

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

    await syncTemplates([makeProject({ repoPath })]);

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
    await syncTemplates([project]);
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
    await syncTemplates([project]);

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

    await syncTemplates([makeProject({ repoPath })]);

    const issueTemplateDir = join(repoPath, ".github", "ISSUE_TEMPLATE");
    expect(readdirSync(issueTemplateDir).sort()).toEqual(["01-fleet-task.yml", "02-fleet-epic.yml"]);
  });

  it("fails open to the generic + epic forms when fleet.yaml is malformed", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "fleet-sync-"));
    repoDirs.push(repoPath);
    writeFileSync(join(repoPath, "fleet.yaml"), "setup: not-a-list-or-map\n");

    await expect(syncTemplates([makeProject({ repoPath })])).resolves.toBeUndefined();

    const issueTemplateDir = join(repoPath, ".github", "ISSUE_TEMPLATE");
    expect(readdirSync(issueTemplateDir).sort()).toEqual(["01-fleet-task.yml", "02-fleet-epic.yml"]);
  });

  it("overwrites previously stamped issue forms on rerun", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "fleet-sync-"));
    repoDirs.push(repoPath);
    const project = makeProject({ repoPath });

    await syncTemplates([project]);
    const destPath = join(repoPath, ".github", "ISSUE_TEMPLATE", "01-fleet-task.yml");
    const first = readFileSync(destPath, "utf8");

    await syncTemplates([project]);
    const second = readFileSync(destPath, "utf8");

    expect(second).toEqual(first);
  });

  it("skips a project whose repoPath does not exist", async () => {
    await expect(syncTemplates([makeProject({ repoPath: join(tmpdir(), "fleet-sync-missing-project") })])).resolves.toBeUndefined();
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
