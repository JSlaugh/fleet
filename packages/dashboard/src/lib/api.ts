import type { BoardTicket, BudgetStatus, HistoryResponse, PendingApproval, TicketDetail, TicketReport } from "@fleet/shared";

export interface BoardResponse {
  tickets: BoardTicket[];
  updatedAt: string;
  pausedUntil?: string;
  paused: boolean;
  pausedProjects: string[];
  runningCount: number;
  budget?: BudgetStatus;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.url} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchBoard(): Promise<BoardResponse> {
  return fetch("/api/board").then((res) => json<BoardResponse>(res));
}

export function fetchTicket(project: string, issueNumber: number): Promise<TicketDetail> {
  return fetch(`/api/tickets/${encodeURIComponent(project)}/${issueNumber}`).then((res) => json<TicketDetail>(res));
}

export interface HistoryQueryParams {
  project?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export function fetchHistory(params: HistoryQueryParams = {}): Promise<HistoryResponse> {
  const search = new URLSearchParams();
  if (params.project) search.set("project", params.project);
  if (params.since) search.set("since", params.since);
  if (params.until) search.set("until", params.until);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const qs = search.toString();
  return fetch(`/api/history${qs ? `?${qs}` : ""}`).then((res) => json<HistoryResponse>(res));
}
export function fetchTicketReport(project: string, issueNumber: number): Promise<TicketReport> {
  return fetch(`/api/tickets/${encodeURIComponent(project)}/${issueNumber}/report`).then((res) =>
    json<TicketReport>(res),
  );
}

export async function setTicketPriority(project: string, issueNumber: number, priority: string | null): Promise<void> {
  await json(
    await fetch(`/api/tickets/${encodeURIComponent(project)}/${issueNumber}/priority`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority }),
    }),
  );
}

export async function sendReply(project: string, issueNumber: number, message: string): Promise<{ mode: string }> {
  const body = await json<{ mode?: string }>(
    await fetch(`/api/tickets/${encodeURIComponent(project)}/${issueNumber}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  );
  return { mode: body.mode ?? "sent" };
}

/** Destructive: terminates the ticket's session and discards its branch work. */
export async function restartTicket(project: string, issueNumber: number): Promise<void> {
  await json(await fetch(`/api/tickets/${encodeURIComponent(project)}/${issueNumber}/restart`, { method: "POST" }));
}

/** Closes a reviewed plan epic's issue; cleanup (worktree/branch/history) happens on the daemon's next poll cycle. */
export async function acceptPlan(project: string, issueNumber: number): Promise<void> {
  await json(await fetch(`/api/tickets/${encodeURIComponent(project)}/${issueNumber}/accept-plan`, { method: "POST" }));
}

/** Toggles drain mode: stops new claims/resumes while leaving running sessions to finish. */
export async function setDaemonPaused(paused: boolean): Promise<void> {
  await json(
    await fetch("/api/daemon/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused }),
    }),
  );
}

/**
 * Aborts live sessions and exits the daemon process with the "restart me"
 * exit code, so a supervisor wrapper (`pnpm daemon:supervised`) relaunches
 * it — the standard way to ship a fleet code change. Interrupted sessions
 * auto-resume on the next boot, same as a manual stop-now.
 */
export async function restartDaemon(): Promise<void> {
  await json(
    await fetch("/api/daemon/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "now" }),
    }),
  );
}

/** Toggles pause for a single project: stops new claims/resumes for it while leaving other projects and its own running sessions unaffected. */
export async function setProjectPaused(project: string, paused: boolean): Promise<void> {
  await json(
    await fetch(`/api/projects/${encodeURIComponent(project)}/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused }),
    }),
  );
}

export function fetchApprovals(): Promise<{ approvals: PendingApproval[] }> {
  return fetch("/api/approvals").then((res) => json<{ approvals: PendingApproval[] }>(res));
}

export async function resolveApproval(id: string, decision: "allow" | "deny" | "answer", message?: string): Promise<void> {
  await json(
    await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, message }),
    }),
  );
}

const WS_RECONNECT_MIN_MS = 3000;
const WS_RECONNECT_MAX_MS = 30000;

export function connectBoardSocket(onEvent: (type: string) => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let reconnectDelay = WS_RECONNECT_MIN_MS;
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      reconnectDelay = WS_RECONNECT_MIN_MS;
      onStatus(true);
    };
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as { type?: string };
        onEvent(parsed.type ?? "unknown");
      } catch {
        onEvent("unknown");
      }
    };
    ws.onerror = () => ws?.close();
    ws.onclose = () => {
      onStatus(false);
      if (!closed) {
        setTimeout(open, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX_MS);
      }
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}

export function formatCost(costUsd: number | undefined): string {
  if (costUsd === undefined || costUsd === 0) return "";
  return `$${costUsd.toFixed(2)}`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDuration(ms: number | undefined | null): string {
  if (!ms) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
