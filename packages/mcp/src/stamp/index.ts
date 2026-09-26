import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentKind } from "@fleet/shared";
import { claudeStamper } from "./claude.ts";
import { codexStamper } from "./codex.ts";
import { LAUNCHER_PATH, readLauncherTemplate, readSkillTemplate } from "./entry.ts";
import { writeRepoConfig, type RepoConfigInput } from "./repo-config.ts";
import type { AgentStamper, McpEntry, StampResult } from "./types.ts";

export const STAMPERS: Record<AgentKind, AgentStamper> = {
  claude: claudeStamper,
  codex: codexStamper,
};

export interface StampOptions {
  /** The machine-local `fleet.config.json` to write alongside the committed files; omitted when the caller manages that file itself. */
  repoConfig?: RepoConfigInput;
  launcherSource?: string;
}

/**
 * Stamps one repo: the committed, machine-neutral launcher plus each requested
 * agent's skill copy and registration (a repeated agent is stamped once), and,
 * when given, the gitignored `fleet.config.json` the launcher reads.
 */
export function stampProject(
  repoPath: string,
  agents: readonly AgentKind[],
  entry: McpEntry,
  skillMarkdown = readSkillTemplate(),
  opts: StampOptions = {},
): StampResult {
  const result: StampResult = { written: [], notes: [] };
  const launcherPath = join(repoPath, LAUNCHER_PATH);
  mkdirSync(dirname(launcherPath), { recursive: true });
  writeFileSync(launcherPath, opts.launcherSource ?? readLauncherTemplate());
  result.written.push(launcherPath);
  if (opts.repoConfig) result.written.push(...writeRepoConfig(repoPath, opts.repoConfig));
  for (const kind of new Set(agents)) {
    const out = STAMPERS[kind].stamp(repoPath, entry, skillMarkdown);
    result.written.push(...out.written);
    result.notes.push(...out.notes);
  }
  return result;
}

export { buildFleetEntry, FLEET_DIR, LAUNCHER_PATH, readSkillTemplate, type EntryTarget } from "./entry.ts";
export { claudeEntry, mergeMcpConfig } from "./claude.ts";
export { mergeCodexConfig, renderCodexFleetTable } from "./codex.ts";
export { ensureIgnored, writeRepoConfig, type RepoConfigInput } from "./repo-config.ts";
export type { AgentStamper, McpEntry, StampResult } from "./types.ts";
