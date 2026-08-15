import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectConfig } from "@fleet/shared";
import { log, logError } from "./log.ts";

const TEMPLATES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "templates");
const SKILL_TEMPLATE_PATH = join(TEMPLATES_DIR, "fleet-backlog", "SKILL.md");
const MCP_TEMPLATE_PATH = join(TEMPLATES_DIR, "mcp.json.example");
const ISSUE_FORMS_DIR = join(TEMPLATES_DIR, "issue-forms");

const BOM = String.fromCharCode(0xfeff);

function stripBom(raw: string): string {
  return raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
}

function loadFleetServerEntry(): Record<string, unknown> {
  const raw = stripBom(readFileSync(MCP_TEMPLATE_PATH, "utf8"));
  const parsed = JSON.parse(raw) as { mcpServers: { fleet: Record<string, unknown> } };
  return parsed.mcpServers.fleet;
}

/**
 * Pure merge: sets/replaces only `mcpServers.fleet`, preserving every other
 * key (and every other server) byte-for-byte semantically. `existingRaw` is
 * `undefined` when the repo has no `.mcp.json` yet.
 */
export function mergeMcpConfig(existingRaw: string | undefined, fleetEntry: Record<string, unknown>): string {
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

function syncSkill(project: ProjectConfig): string {
  const skillTemplate = readFileSync(SKILL_TEMPLATE_PATH, "utf8");
  const destPath = join(project.repoPath, ".claude", "skills", "fleet-backlog", "SKILL.md");
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, skillTemplate);
  return destPath;
}

function syncIssueForms(project: ProjectConfig): string[] {
  const destDir = join(project.repoPath, ".github", "ISSUE_TEMPLATE");
  mkdirSync(destDir, { recursive: true });
  const written: string[] = [];
  for (const fileName of readdirSync(ISSUE_FORMS_DIR)) {
    const destPath = join(destDir, fileName);
    writeFileSync(destPath, readFileSync(join(ISSUE_FORMS_DIR, fileName), "utf8"));
    written.push(destPath);
  }
  return written;
}

function syncMcpJson(project: ProjectConfig, fleetEntryTemplate: Record<string, unknown>): string {
  const destPath = join(project.repoPath, ".mcp.json");
  const existingRaw = existsSync(destPath) ? readFileSync(destPath, "utf8") : undefined;
  const env = { ...(fleetEntryTemplate.env as Record<string, string> | undefined), FLEET_PROJECT: project.name };
  const fleetEntry = { ...fleetEntryTemplate, env };
  const merged = mergeMcpConfig(existingRaw, fleetEntry);
  writeFileSync(destPath, merged);
  return destPath;
}

export async function syncTemplates(projects: ProjectConfig[]): Promise<void> {
  const fleetEntryTemplate = loadFleetServerEntry();
  for (const project of projects) {
    if (!existsSync(project.repoPath)) {
      log("sync-templates", `WARNING: skipping ${project.name} — repoPath ${project.repoPath} does not exist`);
      continue;
    }
    log("sync-templates", `wrote ${syncSkill(project)}`);
    for (const destPath of syncIssueForms(project)) {
      log("sync-templates", `wrote ${destPath}`);
    }
    try {
      log("sync-templates", `wrote ${syncMcpJson(project, fleetEntryTemplate)}`);
    } catch (err) {
      logError("sync-templates", `failed to update .mcp.json for ${project.name}`, err);
    }
  }
  log("sync-templates", "done — these are working-tree changes only; review and commit them in each repo");
}
