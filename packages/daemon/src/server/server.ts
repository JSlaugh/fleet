import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  FLEET_LABELS,
  PRIORITY_LABELS,
  type JournalEntry,
  type TicketDetail,
  type TicketReport,
} from "@fleet/shared";
import type { ApprovalManager } from "../session/approvals.ts";
import { createIssue, setPriority } from "../github/github.ts";
import { log, logError } from "../log.ts";
import type { FleetLoop } from "../loop/loop.ts";
import type { StateStore } from "../store/state.ts";

/**
 * `ready: false` files a plain issue carrying only the priority label, so a
 * human can curate it before a worker picks it up.
 */
export const CreateTicketSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  priority: z.enum(PRIORITY_LABELS).optional(),
  ready: z.boolean().default(true),
  dependsOn: z.array(z.number().int().positive()).optional(),
});

export function labelsForNewTicket(input: z.infer<typeof CreateTicketSchema>): string[] {
  const labels: string[] = [];
  if (input.ready) labels.push(FLEET_LABELS.ready);
  if (input.priority) labels.push(input.priority);
  return labels;
}

/** Appends a `Depends-on: #...` line the daemon's own gating will parse back out. */
export function bodyWithDependsOn(body: string, dependsOn: number[] | undefined): string {
  if (!dependsOn || dependsOn.length === 0) return body;
  const line = `Depends-on: ${dependsOn.map((n) => `#${n}`).join(", ")}`;
  return body.trim().length > 0 ? `${body}\n\n${line}` : line;
}

/** Builds the Hono app without binding a port, so routes are testable via `app.request(...)`. */
export function createApp(opts: {
  loop: FleetLoop;
  state: StateStore;
  approvals: ApprovalManager;
  dataDir: string;
  dashboardDist: string;
  /** Called once shutdown work (drain or stop-now) finishes. Defaults to `process.exit`; tests override it. */
  exit?: (code: number) => void;
}): Hono {
  const { loop, state, approvals, dataDir, dashboardDist, exit = process.exit.bind(process) } = opts;
  const app = new Hono();

  app.get("/api/board", (c) =>
    c.json({
      tickets: loop.getBoard(),
      updatedAt: new Date().toISOString(),
      pausedUntil: state.getPausedUntil(),
      paused: state.getPaused(),
      runningCount: loop.activeCount,
    }),
  );

  app.get("/api/history", (c) => {
    const project = c.req.query("project") || undefined;
    const since = c.req.query("since") || undefined;
    const until = c.req.query("until") || undefined;
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    const offset = offsetParam !== undefined ? Number(offsetParam) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return c.json({ error: "limit must be a positive integer" }, 400);
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      return c.json({ error: "offset must be a non-negative integer" }, 400);
    }
    return c.json(loop.getHistoryPage({ project, since, until, limit, offset }));
  });

  app.post("/api/daemon/pause", async (c) => {
    const { paused } = await c.req.json<{ paused: boolean }>().catch(() => ({ paused: undefined }));
    if (typeof paused !== "boolean") return c.json({ error: "paused must be a boolean" }, 400);
    loop.setPaused(paused);
    return c.json({ ok: true, paused });
  });

  // Terminal: the process exits once the requested mode's work finishes, so
  // the response the client gets back is the last thing this server ever
  // sends. Kicked off rather than awaited — a drain can take arbitrarily long,
  // and the dashboard reads progress off `/api/board` (`paused`/`runningCount`)
  // until the connection drops instead of holding this request open.
  app.post("/api/daemon/shutdown", async (c) => {
    const { mode } = await c.req.json<{ mode?: string }>().catch(() => ({ mode: undefined }));
    if (mode !== "drain" && mode !== "now") return c.json({ error: 'mode must be "drain" or "now"' }, 400);
    if (!loop.beginShutdown()) return c.json({ error: "shutdown already in progress" }, 409);
    log("server", `daemon shutdown requested: ${mode}`);
    void (mode === "drain" ? loop.shutdownDrain() : loop.shutdownNow()).then(() => {
      log("server", `${mode} shutdown complete — exiting`);
      exit(0);
    });
    return c.json({ ok: true, mode });
  });

  app.get("/api/tickets/:project/:issue", (c) => {
    const projectName = c.req.param("project");
    const issueNumber = Number(c.req.param("issue"));
    if (!loop.getProject(projectName) || !Number.isInteger(issueNumber)) {
      return c.json({ error: "unknown project or issue" }, 404);
    }
    const record = state.get(projectName, issueNumber) ?? loop.getHistoryRecord(projectName, issueNumber);
    const ticket = loop.getBoard().find((t) => t.project === projectName && t.issueNumber === issueNumber);
    // Mirrors the /restart route's own known-ticket check, so canRestart never
    // promises an action that route would 404.
    const known = state.get(projectName, issueNumber) !== undefined || ticket !== undefined;
    const { canRestart, canReply } = loop.ticketCapabilities(projectName, issueNumber, known);
    const detail: TicketDetail = {
      ticket,
      record,
      journal: readJournalTail(dataDir, projectName, issueNumber, 200),
      canRestart,
      canReply,
    };
    return c.json(detail);
  });

  app.get("/api/tickets/:project/:issue/report", (c) => {
    const projectName = c.req.param("project");
    const issueNumber = Number(c.req.param("issue"));
    if (!loop.getProject(projectName) || !Number.isInteger(issueNumber)) {
      return c.json({ error: "unknown project or issue" }, 404);
    }
    const journal = readJournalTail(dataDir, projectName, issueNumber, Number.MAX_SAFE_INTEGER);
    return c.json(buildTicketReport(journal));
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

  // Closes out a reviewed plan epic: the issue close is the completion signal
  // `cleanupFinished` acts on next cycle — this route does not touch the
  // worktree/branch/history itself.
  app.post("/api/tickets/:project/:issue/accept-plan", async (c) => {
    const projectName = c.req.param("project");
    const issueNumber = Number(c.req.param("issue"));
    if (!loop.getProject(projectName) || !Number.isInteger(issueNumber)) {
      return c.json({ error: "unknown project or issue" }, 404);
    }
    const record = state.get(projectName, issueNumber);
    if (!record) return c.json({ error: `${projectName}#${issueNumber} is not a known fleet ticket` }, 404);
    if (!record.isPlan) return c.json({ error: `${projectName}#${issueNumber} is not a plan ticket` }, 400);
    if (record.status !== "review") return c.json({ error: `${projectName}#${issueNumber} is not awaiting review` }, 400);
    try {
      await loop.acceptPlan(projectName, issueNumber);
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
        body: bodyWithDependsOn(parsed.data.body, parsed.data.dependsOn),
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

  return app;
}

export function startServer(opts: {
  port: number;
  loop: FleetLoop;
  state: StateStore;
  approvals: ApprovalManager;
  dataDir: string;
  dashboardDist: string;
  exit?: (code: number) => void;
}): void {
  const { port, loop, approvals } = opts;
  const app = createApp(opts);

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

/**
 * Aggregates a ticket's full journal into per-tool/error/turn/cost stats. A
 * "segment" is one worker resumption: from a `claimed`/`resumed` fleet event
 * through the next `result` entry. Every enrichment field (`toolCalls`,
 * `toolResults`, `numTurns`, `durationMs`) is optional on `JournalEntry`, so
 * older journals just fall back to zeroed/null values rather than throwing.
 * Entries from the one-shot machine-review sub-session (`session:
 * "machine-review"`, see review.ts) share this same journal file but aren't
 * the ticket's own worker turn, so they're excluded entirely.
 */
function buildTicketReport(journal: JournalEntry[]): TicketReport {
  const toolCounts: Record<string, number> = {};
  const toolErrorCounts: Record<string, number> = {};
  const toolNameById = new Map<string, string>();
  const segments: TicketReport["segments"] = [];
  let errorCount = 0;
  let segmentOpen = false;

  for (const entry of journal) {
    if (entry.session === "machine-review") continue;

    if (entry.type === "fleet" && (entry.event === "claimed" || entry.event === "resumed")) {
      segmentOpen = true;
      continue;
    }

    if (entry.type === "assistant") {
      if (Array.isArray(entry.toolCalls)) {
        for (const call of entry.toolCalls) {
          toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
          toolNameById.set(call.id, call.name);
        }
      } else if (Array.isArray(entry.tools)) {
        for (const name of entry.tools) toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      }
    }

    if (Array.isArray(entry.toolResults)) {
      for (const result of entry.toolResults) {
        if (!result.isError) continue;
        errorCount += 1;
        const name = toolNameById.get(result.id);
        if (name) toolErrorCounts[name] = (toolErrorCounts[name] ?? 0) + 1;
      }
    }

    if (entry.type === "result" && segmentOpen) {
      segments.push({
        numTurns: typeof entry.numTurns === "number" ? entry.numTurns : null,
        durationMs: typeof entry.durationMs === "number" ? entry.durationMs : null,
        costUsd: typeof entry.costUsd === "number" ? entry.costUsd : 0,
      });
      segmentOpen = false;
    }
  }

  return {
    toolCounts,
    toolErrorCounts,
    errorCount,
    segments,
    totals: {
      toolCalls: Object.values(toolCounts).reduce((sum, n) => sum + n, 0),
      errors: errorCount,
      turns: segments.reduce((sum, s) => sum + (s.numTurns ?? 0), 0),
      durationMs: segments.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
      costUsd: segments.reduce((sum, s) => sum + s.costUsd, 0),
    },
  };
}
