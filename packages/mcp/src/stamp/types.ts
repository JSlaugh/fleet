import type { AgentKind } from "@fleet/shared";

/** The `fleet` MCP server entry, agent-neutral: each stamper renders it into that agent's registration file. */
export interface McpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface StampResult {
  /** Absolute paths written. */
  written: string[];
  /** Follow-up reminders for the human (e.g. Codex only loads project config from trusted directories). */
  notes: string[];
}

/**
 * One per agent. `stamp` writes that agent's skill copy and MCP registration
 * into a repo's working tree, merging into an existing registration file
 * rather than replacing it, and is idempotent.
 */
export interface AgentStamper {
  kind: AgentKind;
  stamp(repoPath: string, entry: McpEntry, skillMarkdown: string): StampResult;
}
