import type { BoardTicket, TicketDetail } from "@fleet/shared";

export interface BoardResponse {
  tickets: BoardTicket[];
  updatedAt: string;
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

export function connectBoardSocket(onUpdate: () => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = () => onUpdate();
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
