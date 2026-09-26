import { z } from "zod";
import { fetchTicketReport, formatTicketReportText } from "../daemon.ts";
import { errorResult, requireProject, textResult, type FleetTool } from "./types.ts";

export const ticketReportTool: FleetTool = {
  name: "fleet_ticket_report",
  home: "daemon",
  register(server, deps) {
    const daemon = deps.daemon!;
    server.registerTool(
      this.name,
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
          const report = await fetchTicketReport(daemon.url, requireProject(project, daemon), issue);
          return textResult(formatTicketReportText(report));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  },
};
