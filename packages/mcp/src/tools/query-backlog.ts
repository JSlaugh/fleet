import { formatBacklogText } from "../tickets.ts";
import { errorResult, textResult, type FleetTool } from "./types.ts";

export const queryBacklogTool: FleetTool = {
  name: "fleet_query_backlog",
  home: "tickets",
  register(server, deps) {
    server.registerTool(
      this.name,
      {
        title: "Query the fleet backlog",
        description: "Lists this project's open fleet tickets (number, title, status, priority), live from GitHub. Use to check for duplicates before filing a new ticket.",
        inputSchema: {},
      },
      async () => {
        try {
          return textResult(formatBacklogText(await deps.tickets.queryBacklog()));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  },
};
