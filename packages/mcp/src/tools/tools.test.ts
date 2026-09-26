import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { TicketGateway } from "../tickets.ts";
import { ALL_TOOLS, registerTools } from "./index.ts";

const tickets: TicketGateway = {
  fileTicket: async () => ({ number: 1, url: "u" }),
  queryBacklog: async () => [],
};

describe("registerTools", () => {
  it("registers only the GitHub-backed tools when there is no daemon", () => {
    const names = registerTools(new McpServer({ name: "t", version: "0" }), { tickets });
    expect(names).toEqual(["fleet_file_ticket", "fleet_query_backlog"]);
  });

  it("registers every tool when a daemon URL is known", () => {
    const names = registerTools(new McpServer({ name: "t", version: "0" }), { tickets, daemon: { url: "http://localhost:4400" } });
    expect(names).toEqual(ALL_TOOLS.map((t) => t.name));
  });

  it("every tool declares exactly one home", () => {
    for (const tool of ALL_TOOLS) expect(["tickets", "daemon"]).toContain(tool.home);
  });
});
