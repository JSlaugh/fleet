import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { FLEET_LABELS, PRIORITY_LABELS, type JournalEntry, type TicketDetail } from "@fleet/shared";
import type { ApprovalManager } from "./approvals.ts";
import { createIssue, setPriority } from "./github.ts";
import { log, logError } from "./log.ts";
import type { FleetLoop } from "./loop.ts";
import type { StateStore } from "./state.ts";

/**
 * `ready: false` files a plain issue carrying only the priority label, so a
 * human can curate it before a worker picks it up.
 */
export const CreateTicketSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  priority: z.enum(PRIORITY_LABELS).optional(),
  ready: z.boolean().default(true),
});

export function labelsForNewTicket(input: z.infer<typeof CreateTicketSchema>): string[] {
  const labels: string[] = [];
  if (input.ready) labels.push(FLEET_LABELS.ready);
  if (input.priority) labels.push(input.priority);
  return labels;
}

export function startServer(opts: {
  port: number;
  loop: FleetLoop;
  state: StateStore;
  approvals: ApprovalManager;
  dataDir: string;
  dashboardDist: string;
}): void {
  const { port, loop, state, approvals, dataDir, dashboardDist } = opts;
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

  app.post("/api/tickets/:project/:issue/reply", async (c) => {
    const projectName = c.req.param("project");
    const issueNumber = Number(c.req.param("issue"));
    const { message } = await c.req.json<{ message: string }>();
    if (typeof message !== "string" || message.trim().length === 0) {
      return c.json({ error: "message is required" }, 400);
    }
    try {
      const mode = await loop.reply(projectName, issueNumber, message.trim());
      return c.json({ ok: true, mode });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  // Destructive: force-closes the session and re-queues the issue, which
  // discards the branch and worktree the old session built. The dashboard
  // confirms with the operator before calling this.
  app.post("/api/tickets/:project/:issue/restart", async (c) => {
    const projectName = c.req.param("project");
    const issueNumber = Number(c.req.param("issue"));
    if (!loop.getProject(projectName) || !Number.isInteger(issueNumber)) {
      return c.json({ error: "unknown project or issue" }, 404);
    }
    const known =
      state.get(projectName, issueNumber) ??
      loop.getBoard().find((t) => t.project === projectName && t.issueNumber === issueNumber);
    if (!known) return c.json({ error: `${projectName}#${issueNumber} is not a known fleet ticket` }, 404);
    try {
      await loop.restartTicket(projectName, issueNumber);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  // Agent-facing intake: file a fleet ticket without touching `gh` directly, so
  // GitHub stays the single source of truth for the board.
  app.post("/api/projects/:project/tickets", async (c) => {
    const name = c.req.param("project");
    const project = loop.getProject(name);
    if (!project) return c.json({ error: `unknown project ${name}` }, 404);
    const parsed = CreateTicketSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
    const labels = labelsForNewTicket(parsed.data);
    try {
      const { number, url } = await createIssue(project, {
        title: parsed.data.title,
        body: parsed.data.body,
        labels,
      });
      log("server", `filed ${name}#${number} [${labels.join(", ") || "no labels"}]`);
      return c.json({ ok: true, number, url });
    } catch (err) {
      logError("server", `creating an issue in ${name}`, err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // The dedup surface: callers check this before filing. It reads the board
  // cache, which only refreshes on the poll loop's cycle, so a ticket filed
  // moments ago may not appear here yet.
  app.get("/api/projects/:project/backlog", (c) => {
    const name = c.req.param("project");
    if (!loop.getProject(name)) return c.json({ error: `unknown project ${name}` }, 404);
    const tickets = loop
      .getBoard()
      .filter((t) => t.project === name)
      .map((t) => ({ number: t.issueNumber, title: t.title, status: t.status, priority: t.priority, url: t.url }));
    return c.json({ tickets });
  });

  app.get("/api/approvals", (c) => c.json({ approvals: approvals.list() }));

  app.post("/api/approvals/:id", async (c) => {
    const { decision, message } = await c.req.json<{ decision: "allow" | "deny" | "answer"; message?: string }>();
    if (decision !== "allow" && decision !== "deny" && decision !== "answer") {
      return c.json({ error: "decision must be allow, deny, or answer" }, 400);
    }
    if (decision === "answer" && (typeof message !== "string" || message.trim().length === 0)) {
      return c.json({ error: "answer requires a message" }, 400);
    }
    const settled = approvals.resolve(c.req.param("id"), {
      allowed: decision === "allow",
      message: decision === "answer" ? message?.trim() : undefined,
    });
    if (!settled) return c.json({ error: "approval not found (already settled or timed out)" }, 404);
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

  const broadcast = (type: string) => {
    const payload = JSON.stringify({ type });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  };
  loop.events.on("board", () => broadcast("board-updated"));
  approvals.events.on("approvals", () => broadcast("approvals-updated"));

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
