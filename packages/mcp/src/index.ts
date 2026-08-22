import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_HISTORY_LIMIT,
  fetchBoardStatus,
  fetchHistory,
  fetchTicketJournal,
  fetchTicketReport,
  fileTicket,
  formatBacklogText,
  formatBoardStatusText,
  formatHistoryText,
  formatJournalText,
  formatTicketReportText,
  queryBacklog,
} from "./client.ts";

const FLEET_URL = process.env.FLEET_URL ?? "http://localhost:4400";
const FLEET_PROJECT = process.env.FLEET_PROJECT;

if (!FLEET_PROJECT) {
  console.error("FLEET_PROJECT env var is required (the project name as registered in fleet.config.json)");
  process.exit(1);
}

function errorResult(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
}

const server = new McpServer({ name: "fleet", version: "0.0.1" });

server.registerTool(
  "fleet_file_ticket",
  {
    title: "File a fleet ticket",
    description:
      "Files a GitHub issue in this project's fleet backlog. The body must contain a problem statement, " +
      "acceptance criteria, and verification steps — the fleet worker that eventually picks up the ticket has " +
      "no memory of this conversation, so the ticket must be fully self-contained. Check fleet_query_backlog " +
      "first to avoid filing a duplicate.",
    inputSchema: {
      title: z.string().min(1).describe("Short, specific issue title"),
      body: z.string().min(1).describe("Problem statement, acceptance criteria, and verification steps, in markdown"),
      priority: z.enum(["p1", "p2", "p3"]).optional().describe("p1 = highest priority, p3 = lowest"),
      ready: z.boolean().optional().describe("True (default) to make the ticket immediately pickable; false to file it for human curation first"),
      dependsOn: z.array(z.number().int().positive()).optional().describe("issue numbers this ticket depends on; it stays blocked until they close"),
    },
  },
  async ({ title, body, priority, ready, dependsOn }) => {
    try {
      const result = await fileTicket(FLEET_URL, FLEET_PROJECT, { title, body, priority, ready, dependsOn });
      return { content: [{ type: "text", text: `Filed ${FLEET_PROJECT}#${result.number}: ${result.url}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "fleet_query_backlog",
  {
    title: "Query the fleet backlog",
    description: "Lists this project's fleet tickets (number, title, status, priority). Use to check for duplicates before filing a new ticket.",
    inputSchema: {},
  },
  async () => {
    try {
      const tickets = await queryBacklog(FLEET_URL, FLEET_PROJECT);
      return { content: [{ type: "text", text: formatBacklogText(tickets) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "fleet_board_status",
  {
    title: "Get fleet board status",
    description: "Returns per-column ticket counts across all projects on the fleet board, plus currently running tickets with their latest activity.",
    inputSchema: {},
  },
  async () => {
    try {
      const summary = await fetchBoardStatus(FLEET_URL);
      return { content: [{ type: "text", text: formatBoardStatusText(summary) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "fleet_ticket_history",
  {
    title: "Query closed fleet ticket history",
    description:
      "Lists recently closed (archived) fleet tickets with their outcomes — PR merged/closed, cost, model, review " +
      "rounds, human rework, machine-review result — plus aggregate stats over the full filtered set. Use to " +
      "evaluate how past tickets went before filing similar work or when asked how fleet has been performing.",
    inputSchema: {
      since: z.string().optional().describe("Only tickets closed at or after this ISO date/timestamp"),
      until: z.string().optional().describe("Only tickets closed at or before this ISO date/timestamp"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(`Max records to list (default ${DEFAULT_HISTORY_LIMIT}); aggregates always cover the full filtered set`),
      allProjects: z.boolean().optional().describe("True to include every fleet project, not just this repo's"),
    },
  },
  async ({ since, until, limit, allProjects }) => {
    try {
      const history = await fetchHistory(FLEET_URL, {
        project: allProjects ? undefined : FLEET_PROJECT,
        since,
        until,
        limit,
      });
      return { content: [{ type: "text", text: formatHistoryText(history) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "fleet_ticket_report",
  {
    title: "Get a fleet ticket's session report",
    description:
      "Aggregated stats from one ticket's worker-session journal: per-tool call/error counts, session segments " +
      "(turns, duration, cost per resumption), bash-contract denials, approval wait times, and machine-review " +
      "findings. Use to dig into why a specific ticket was slow, expensive, or error-prone.",
    inputSchema: {
      issue: z.number().int().positive().describe("Issue number"),
      project: z.string().optional().describe("Fleet project name; defaults to this repo's project"),
    },
  },
  async ({ issue, project }) => {
    try {
      const report = await fetchTicketReport(FLEET_URL, project ?? FLEET_PROJECT, issue);
      return { content: [{ type: "text", text: formatTicketReportText(report) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "fleet_ticket_journal",
  {
    title: "Read a fleet ticket's journal",
    description:
      "The tail of one ticket's session journal — a one-line-per-entry narrative of what the worker actually did " +
      "(assistant messages, tool calls, operator steering, fleet lifecycle events). Use fleet_ticket_report first " +
      "for the numbers; read the journal when you need the story behind them.",
    inputSchema: {
      issue: z.number().int().positive().describe("Issue number"),
      project: z.string().optional().describe("Fleet project name; defaults to this repo's project"),
      limit: z.number().int().min(1).max(200).optional().describe("Max journal entries, newest kept (default 50)"),
    },
  },
  async ({ issue, project, limit }) => {
    try {
      const journal = await fetchTicketJournal(FLEET_URL, project ?? FLEET_PROJECT, issue);
      return { content: [{ type: "text", text: formatJournalText(journal.slice(-(limit ?? 50))) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
