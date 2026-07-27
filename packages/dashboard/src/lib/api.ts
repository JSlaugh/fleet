import type { BoardTicket, PendingApproval, TicketDetail } from "@fleet/shared";

export interface BoardResponse {
  tickets: BoardTicket[];
  updatedAt: string;
  pausedUntil?: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export function fetchBoard(): Promise<BoardResponse> {
  return fetch("/api/board").then((res) => json<BoardResponse>(res));
}

export function fetchTicket(project: string, issueNumber: number): Promise<TicketDetail> {
  return fetch(`/api/tickets/${encodeURIComponent(project)}/${issueNumber}`).then((res) => json<TicketDetail>(res));
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
  const res = await fetch(`/api/tickets/${encodeURIComponent(project)}/${issueNumber}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const body = (await res.json()) as { mode?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `reply failed: ${res.status}`);
  return { mode: body.mode ?? "sent" };
}

/** Destructive: terminates the ticket's session and discards its branch work. */
export async function restartTicket(project: string, issueNumber: number): Promise<void> {
  const res = await fetch(`/api/tickets/${encodeURIComponent(project)}/${issueNumber}/restart`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `restart failed: ${res.status}`);
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

export function connectBoardSocket(onEvent: (type: string) => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as { type?: string };
        onEvent(parsed.type ?? "unknown");
      } catch {
        onEvent("unknown");
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed) setTimeout(open, 3000);
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
