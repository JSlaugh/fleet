import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLEET_LABELS, PLAN_LABEL, profileNames, typeLabel, type BuildSpec, type ProjectConfig } from "@fleet/shared";
import { readBuildSpec } from "./github/buildspec.ts";
import { log, logError } from "./log.ts";

const TEMPLATES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "templates");
const SKILL_TEMPLATE_PATH = join(TEMPLATES_DIR, "fleet-backlog", "SKILL.md");
const MCP_TEMPLATE_PATH = join(TEMPLATES_DIR, "mcp.json.example");

const BOM = String.fromCharCode(0xfeff);

function stripBom(raw: string): string {
  return raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
}

/**
 * The template carries `{{FLEET_DIR}}`/`{{FLEET_URL}}` placeholders rather
 * than literal values: the fleet checkout's path differs per machine and the
 * port is config, and a stamped-verbatim absolute path silently breaks the
 * MCP server in every registered repo on any other clone.
 */
function loadFleetServerEntry(port: number): Record<string, unknown> {
  const fleetDir = join(TEMPLATES_DIR, "..").replace(/\\/g, "/");
  const raw = stripBom(readFileSync(MCP_TEMPLATE_PATH, "utf8"))
    .replaceAll("{{FLEET_DIR}}", fleetDir)
    .replaceAll("{{FLEET_URL}}", `http://localhost:${port}`);
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

const GUIDANCE_BULLETS = `        - **Priority** is a label, not a field: add \`fleet:p1\` / \`fleet:p2\` / \`fleet:p3\` after filing (optional).
        - **Dependencies:** put a line \`Depends-on: #12, #14\` anywhere below and fleet won't claim this until those issues close.
        - **Timeout:** put a line \`Timeout: 60m\` (or \`2h\`) anywhere below to override the default per-turn timeout for this ticket, up to a 240m max.
        - Not ready to queue it yet? Remove the \`${FLEET_LABELS.ready}\` label after filing.`;

const TASK_BODY_FIELDS = `  - type: textarea
    id: problem
    attributes:
      label: Problem
      description: What's wrong or missing, and why it matters. Name the files involved if you know them.
    validations:
      required: true
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria
      description: What "done" looks like, as a concrete, checkable list.
      placeholder: |
        - [ ] ...
    validations:
      required: true
  - type: textarea
    id: verification
    attributes:
      label: Verification
      description: The commands or checks the worker should run to confirm the change.
      placeholder: |
        - \`pnpm typecheck\`
        - \`pnpm test\`
    validations:
      required: true
`;

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function genericTaskForm(): string {
  return `name: Fleet task
description: A self-contained, PR-sized task for a fleet worker. Files as ${FLEET_LABELS.ready} — a worker may claim it on the next poll.
labels: ["${FLEET_LABELS.ready}"]
body:
  - type: markdown
    attributes:
      value: |
        The worker that picks this up sees only this issue (body plus comments) — it has no other context.
        Name exact file paths wherever you know them.

${GUIDANCE_BULLETS}
${TASK_BODY_FIELDS}`;
}

function typeTaskForm(name: string): string {
  const label = typeLabel(name);
  // The name contains ": " and must be quoted — unquoted it is invalid YAML,
  // and GitHub silently drops the form from the New Issue chooser.
  return `name: "Fleet task: ${capitalize(name)}"
description: A fleet task scoped to the "${name}" fleet.yaml setup profile. Files as ${FLEET_LABELS.ready} + ${label}.
labels: ["${FLEET_LABELS.ready}", "${label}"]
body:
  - type: markdown
    attributes:
      value: |
        This ticket runs fleet.yaml's "${name}" setup profile. The worker that picks this up sees only this issue (body plus comments) — it has no other context.
        Name exact file paths wherever you know them.

${GUIDANCE_BULLETS}
${TASK_BODY_FIELDS}`;
}

function epicForm(): string {
  return `name: Fleet epic
description: A large item for the planner to decompose into child tickets. Files as ${PLAN_LABEL} + ${FLEET_LABELS.ready} — decomposition may start on the next poll.
labels: ["${PLAN_LABEL}", "${FLEET_LABELS.ready}"]
body:
  - type: markdown
    attributes:
      value: |
        A planner session reads this epic and files each proposed child as a real issue
        (linked back here via \`Part-of:\`), so the problem statement carries all the weight —
        acceptance criteria and verification belong on the children, not here.

        Not ready to kick off decomposition yet? Remove the \`${FLEET_LABELS.ready}\` label after filing.
  - type: textarea
    id: problem
    attributes:
      label: Problem
      description: The full shape of the work — what exists today, what should exist, and why. The planner only knows what you write here.
    validations:
      required: true
  - type: textarea
    id: shaping
    attributes:
      label: Shaping notes
      description: Optional — constraints, a suggested split, sequencing that matters, or what's explicitly out of scope.
    validations:
      required: false
`;
}

/**
 * Every filename `issueFormFiles` can produce matches this — the numeric
 * chooser-ordering prefix plus a `fleet-task`/`fleet-epic` stem that no
 * hand-authored issue form would plausibly collide with. `syncIssueForms`
 * uses it to find its own previously-generated files (and only those) when
 * reconciling the directory against the current `fleet.yaml`.
 */
const GENERATED_FORM_PATTERN = /^\d{2}-fleet-(task(-.+)?|epic)\.yml$/;

/**
 * One generic task form, one task form per non-default `fleet.yaml` profile
 * (numbered in the order the profile appears in the spec, matching how
 * `ensureLabels` mints their `fleet:type:*` labels), and the epic form last —
 * numbered so GitHub's issue-template chooser lists them in this order.
 * `spec` is undefined for a repo with no `fleet.yaml` (or a list-form one,
 * since `profileNames` already returns `[]` for that shape), which yields
 * just the generic + epic forms.
 */
export function issueFormFiles(spec: BuildSpec | undefined): { fileName: string; content: string }[] {
  const profiles = spec ? profileNames(spec) : [];
  const files = [{ fileName: "01-fleet-task.yml", content: genericTaskForm() }];
  profiles.forEach((name, i) => {
    files.push({ fileName: `${String(i + 2).padStart(2, "0")}-fleet-task-${name}.yml`, content: typeTaskForm(name) });
  });
  files.push({ fileName: `${String(profiles.length + 2).padStart(2, "0")}-fleet-epic.yml`, content: epicForm() });
  return files;
}

/**
 * Removes previously-generated issue forms that the current `fleet.yaml` no
 * longer produces — e.g. a renamed or removed setup profile — so a shrinking
 * profile set doesn't leave a defunct form (and its `fleet:type:*` label)
 * sitting in GitHub's issue-template chooser forever. Only touches files
 * matching `GENERATED_FORM_PATTERN`; anything else in the directory (a
 * repo's own issue forms, `config.yml`) is left alone.
 */
function pruneStaleIssueForms(destDir: string, keep: Set<string>): string[] {
  const removed: string[] = [];
  for (const fileName of readdirSync(destDir)) {
    if (GENERATED_FORM_PATTERN.test(fileName) && !keep.has(fileName)) {
      const destPath = join(destDir, fileName);
      rmSync(destPath);
      removed.push(destPath);
    }
  }
  return removed;
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

  let spec: BuildSpec | undefined;
  try {
    spec = readBuildSpec(project.repoPath);
  } catch (err) {
    logError("sync-templates", `${project.name}: fleet.yaml is invalid — generating issue forms without type profiles`, err);
  }

  const files = issueFormFiles(spec);
  for (const removedPath of pruneStaleIssueForms(destDir, new Set(files.map((f) => f.fileName)))) {
    log("sync-templates", `removed stale ${removedPath}`);
  }

  const written: string[] = [];
  for (const { fileName, content } of files) {
    const destPath = join(destDir, fileName);
    writeFileSync(destPath, content);
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

export async function syncTemplates(projects: ProjectConfig[], opts: { port?: number } = {}): Promise<void> {
  const fleetEntryTemplate = loadFleetServerEntry(opts.port ?? 4400);
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
