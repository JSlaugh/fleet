import { z } from "zod";
import { fetchTicketJournal, formatJournalText } from "../daemon.ts";
import { errorResult, requireProject, textResult, type FleetTool } from "./types.ts";

export const ticketJournalTool: FleetTool = {
  name: "fleet_ticket_journal",
  home: "daemon",
  register(server, deps) {
    const daemon = deps.daemon!;
    server.registerTool(
      this.name,
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
          const journal = await fetchTicketJournal(daemon.url, requireProject(project, daemon), issue);
          return textResult(formatJournalText(journal.slice(-(limit ?? 50))));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  },
};
