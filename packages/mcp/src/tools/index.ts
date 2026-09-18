import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { boardStatusTool } from "./board-status.ts";
import { fileTicketTool } from "./file-ticket.ts";
import { historyTool } from "./history.ts";
import { queryBacklogTool } from "./query-backlog.ts";
import { ticketJournalTool } from "./ticket-journal.ts";
import { ticketReportTool } from "./ticket-report.ts";
import type { FleetTool, ToolDeps } from "./types.ts";

export const ALL_TOOLS: readonly FleetTool[] = [
  fileTicketTool,
  queryBacklogTool,
  boardStatusTool,
  historyTool,
  ticketReportTool,
  ticketJournalTool,
];

/** Registers every tool whose home is available; returns the names registered, for the startup log. */
export function registerTools(server: McpServer, deps: ToolDeps, tools: readonly FleetTool[] = ALL_TOOLS): string[] {
  const registered: string[] = [];
  for (const tool of tools) {
    if (tool.home === "daemon" && !deps.daemon) continue;
    tool.register(server, deps);
    registered.push(tool.name);
  }
  return registered;
}

export type { FleetTool, ToolDeps } from "./types.ts";
