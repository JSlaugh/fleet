import { fetchBoardStatus, formatBoardStatusText } from "../daemon.ts";
import { errorResult, textResult, type FleetTool } from "./types.ts";

export const boardStatusTool: FleetTool = {
  name: "fleet_board_status",
  home: "daemon",
  register(server, deps) {
    const daemon = deps.daemon!;
    server.registerTool(
      this.name,
      {
        title: "Get fleet board status",
        description: "Returns per-column ticket counts across all projects on the fleet board, plus currently running tickets with their latest activity.",
        inputSchema: {},
      },
      async () => {
        try {
          return textResult(formatBoardStatusText(await fetchBoardStatus(daemon.url)));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  },
};
