import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { PRIORITY_LABELS, type JournalEntry, type TicketDetail } from "@fleet/shared";
import { setPriority } from "./github.ts";
import { log, logError } from "./log.ts";
import type { FleetLoop } from "./loop.ts";
import type { StateStore } from "./state.ts";

export function startServer(opts: {
  port: number;
  loop: FleetLoop;
  state: StateStore;
  dataDir: string;
  dashboardDist: string;
}): void {
  const { port, loop, state, dataDir, dashboardDist } = opts;
  const app = new Hono();

  app.get("/api/board", (c) => c.json({ tickets: loop.getBoard(), updatedAt: new Date().toISOString() }));

  app.get("/api/tickets/:project/:issue", (c) => {
    const project = c.req.param("project");
    const issueNumber = Number(c.req.param("issue"));
    const record = state.get(project, issueNumber);
    const ticket = loop.getBoard().find((t) => t.project === project && t.issueNumber === issueNumber);
    const detail: TicketDetail = { ticket, record, journal: readJournalTail(dataDir, project, issueNumber, 200) };
    return c.json(detail);
  });

  app.post("/api/tickets/:project/:issue/priority", async (c) => {
    const project = loop.getProject(c.req.param("project"));
    const issueNumber = Number(c.req.param("issue"));
    if (!project || !Number.isInteger(issueNumber)) return c.json({ error: "unknown project or issue" }, 404);
    const { priority } = await c.req.json<{ priority: string | null }>();
    if (priority !== null && !(PRIORITY_LABELS as readonly string[]).includes(priority)) {
      return c.json({ error: `priority must be one of ${PRIORITY_LABELS.join(", ")} or null` }, 400);
    }
    await setPriority(project, issueNumber, priority);
    return c.json({ ok: true });
  });

  if (existsSync(dashboardDist)) {
    app.use("*", serveStatic({ root: relative(process.cwd(), dashboardDist).replaceAll("\\", "/") || "." }));
    app.notFound((c) => c.html(readFileSync(join(dashboardDist, "index.html"), "utf8")));
  } else {
    app.notFound((c) =>
      c.text("Fleet daemon is running. Dashboard build not found — run `pnpm --filter @fleet/dashboard build`.", 404),
    );
  }

  const httpServer = serve({ fetch: app.fetch, port }) as Server;
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  loop.events.on("board", () => {
    const payload = JSON.stringify({ type: "board-updated" });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  });

  log("server", `dashboard + API listening on http://localhost:${port}`);
}

function readJournalTail(dataDir: string, project: string, issueNumber: number, limit: number): JournalEntry[] {
  const file = join(dataDir, "journals", project, `${issueNumber}.jsonl`);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as JournalEntry);
  } catch (err) {
    logError("server", `reading journal for ${project}#${issueNumber}`, err);
    return [];
  }
}
