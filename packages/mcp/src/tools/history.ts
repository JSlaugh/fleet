import { z } from "zod";
import { DEFAULT_HISTORY_LIMIT, fetchHistory, formatHistoryText } from "../daemon.ts";
import { errorResult, requireProject, textResult, type FleetTool } from "./types.ts";

export const historyTool: FleetTool = {
  name: "fleet_ticket_history",
  home: "daemon",
  register(server, deps) {
    const daemon = deps.daemon!;
    server.registerTool(
      this.name,
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
          const project = allProjects ? undefined : requireProject(undefined, daemon);
          return textResult(formatHistoryText(await fetchHistory(daemon.url, { project, since, until, limit })));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  },
};
