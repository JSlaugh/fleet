import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TicketGateway } from "../tickets.ts";

/** What the daemon-backed tools need: where the daemon is, and which project to default to. */
export interface DaemonTarget {
  url: string;
  project?: string;
}

export interface ToolDeps {
  tickets: TicketGateway;
  /** Absent when no daemon is configured — daemon tools are then not registered at all. */
  daemon?: DaemonTarget;
}

/**
 * One file per tool. `home` says which backend the tool reads: `tickets` tools
 * always register (GitHub is always reachable in principle); `daemon` tools
 * register only when `deps.daemon` is set.
 */
export interface FleetTool {
  name: string;
  home: "tickets" | "daemon";
  register(server: McpServer, deps: ToolDeps): void;
}

export function errorResult(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
}

export function textResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

/** Daemon tools that take a project need one from somewhere; say exactly how to supply it. */
export function requireProject(explicit: string | undefined, daemon: DaemonTarget): string {
  const project = explicit ?? daemon.project;
  if (!project) {
    throw new Error("No fleet project name is known: pass `project`, or set FLEET_PROJECT (or a fleet.config.json that lists this repo).");
  }
  return project;
}
