import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findConfigFile, readProjectsConfig } from "./config-file.ts";
import { resolveTarget } from "./resolve.ts";
import { DaemonFirstTickets, GithubTickets } from "./tickets.ts";
import { registerTools } from "./tools/index.ts";

// stdout is the MCP transport; everything human-facing goes to stderr — including
// `log()` from shared code (`@fleet/github` warns through it), which writes to
// console.log and would otherwise corrupt the JSON-RPC stream.
console.log = console.error;

let target;
try {
  target = resolveTarget(process.env, {
    loadConfig: (explicit) => {
      const path = findConfigFile(process.cwd(), explicit);
      return path ? { path, config: readProjectsConfig(path) } : undefined;
    },
  });
} catch (err) {
  console.error(`fleet mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const server = new McpServer({ name: "fleet", version: "0.0.1" });
const github = new GithubTickets(target.repo, undefined, target.intakeLint);
const registered = registerTools(server, {
  tickets: target.daemonUrl && target.project ? new DaemonFirstTickets(github, { url: target.daemonUrl, project: target.project }) : github,
  daemon: target.daemonUrl ? { url: target.daemonUrl, project: target.project } : undefined,
});
console.error(`fleet mcp: ${target.describe}; tools: ${registered.join(", ")}`);

await server.connect(new StdioServerTransport());
