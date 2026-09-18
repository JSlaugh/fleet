import type { AgentKind } from "@fleet/shared";
import { claudeStamper } from "./claude.ts";
import { codexStamper } from "./codex.ts";
import { readSkillTemplate } from "./entry.ts";
import type { AgentStamper, McpEntry, StampResult } from "./types.ts";

export const STAMPERS: Record<AgentKind, AgentStamper> = {
  claude: claudeStamper,
  codex: codexStamper,
};

/** Stamps one repo for each requested agent from the single skill template; a repeated agent is stamped once. */
export function stampProject(repoPath: string, agents: readonly AgentKind[], entry: McpEntry, skillMarkdown = readSkillTemplate()): StampResult {
  const result: StampResult = { written: [], notes: [] };
  for (const kind of new Set(agents)) {
    const out = STAMPERS[kind].stamp(repoPath, entry, skillMarkdown);
    result.written.push(...out.written);
    result.notes.push(...out.notes);
  }
  return result;
}

export { buildFleetEntry, FLEET_DIR, readSkillTemplate, type EntryTarget } from "./entry.ts";
export { mergeMcpConfig } from "./claude.ts";
export { mergeCodexConfig, renderCodexFleetTable } from "./codex.ts";
export type { AgentStamper, McpEntry, StampResult } from "./types.ts";
