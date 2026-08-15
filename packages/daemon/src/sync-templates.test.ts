import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeProject } from "./test-support.ts";
import { mergeMcpConfig, syncTemplates } from "./sync-templates.ts";

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

  it("stamps the skill and both issue forms into a project's working tree", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "fleet-sync-"));
    repoDirs.push(repoPath);

    await syncTemplates([makeProject({ repoPath })]);

    expect(existsSync(join(repoPath, ".claude", "skills", "fleet-backlog", "SKILL.md"))).toBe(true);

    const issueTemplateDir = join(repoPath, ".github", "ISSUE_TEMPLATE");
    expect(readdirSync(issueTemplateDir).sort()).toEqual(["fleet-plan.yml", "fleet-task.yml"]);

    const taskForm = readFileSync(join(issueTemplateDir, "fleet-task.yml"), "utf8");
    expect(taskForm).toContain("name: Fleet task");
    expect(taskForm).toContain("id: problem");

    const planForm = readFileSync(join(issueTemplateDir, "fleet-plan.yml"), "utf8");
    expect(planForm).toContain("name: Fleet plan (epic)");
  });

  it("overwrites previously stamped issue forms on rerun", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "fleet-sync-"));
    repoDirs.push(repoPath);
    const project = makeProject({ repoPath });

    await syncTemplates([project]);
    const destPath = join(repoPath, ".github", "ISSUE_TEMPLATE", "fleet-task.yml");
    const first = readFileSync(destPath, "utf8");

    await syncTemplates([project]);
    const second = readFileSync(destPath, "utf8");

    expect(second).toEqual(first);
  });

  it("skips a project whose repoPath does not exist", async () => {
    await expect(syncTemplates([makeProject({ repoPath: join(tmpdir(), "fleet-sync-missing-project") })])).resolves.toBeUndefined();
  });
});
