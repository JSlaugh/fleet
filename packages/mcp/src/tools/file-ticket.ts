import { z } from "zod";
import { errorResult, textResult, type FleetTool } from "./types.ts";

export const fileTicketTool: FleetTool = {
  name: "fleet_file_ticket",
  home: "tickets",
  register(server, deps) {
    server.registerTool(
      this.name,
      {
        title: "File a fleet ticket",
        description:
          "Files a GitHub issue in this project's fleet backlog. The body must contain a problem statement, " +
          "acceptance criteria, and verification steps as markdown headings — the fleet worker that eventually " +
          "picks up the ticket has no memory of this conversation, so the ticket must be fully self-contained. " +
          "Check fleet_query_backlog first to avoid filing a duplicate.",
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
          const result = await deps.tickets.fileTicket({ title, body, priority, ready, dependsOn });
          return textResult(`Filed #${result.number}: ${result.url}`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  },
};
