export type Priority = "p1" | "p2" | "p3";

export function priorityLabel(priority: Priority | undefined): string | undefined {
  return priority ? `fleet:${priority}` : undefined;
}

export interface FileTicketInput {
  title: string;
  body: string;
  priority?: Priority;
  ready?: boolean;
}

/** Builds the JSON body for `POST /api/projects/:project/tickets` from the MCP tool's input. */
export function buildFileTicketRequest(input: FileTicketInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { title: input.title, body: input.body };
  const priority = priorityLabel(input.priority);
  if (priority) payload.priority = priority;
  if (input.ready !== undefined) payload.ready = input.ready;
  return payload;
}

export interface FileTicketResult {
  number: number;
  url: string;
}

export interface BacklogTicket {
  number: number;
  title: string;
  status: string;
  priority: string | null;
  url: string;
}

export interface BoardTicketLike {
  project: string;
  issueNumber: number;
  title: string;
  status: string;
  record?: { status?: string; lastActivityNote?: string };
}

export interface RunningTicket {
  project: string;
  issueNumber: number;
  title: string;
  lastActivityNote?: string;
}

export interface BoardSummary {
  counts: Record<string, number>;
  running: RunningTicket[];
}

/** Tallies board tickets per column and pulls out the ones with a live session. */
export function summarizeBoard(tickets: BoardTicketLike[]): BoardSummary {
  const counts: Record<string, number> = {};
  const running: RunningTicket[] = [];
  for (const t of tickets) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
    if (t.record?.status === "running") {
      running.push({
        project: t.project,
        issueNumber: t.issueNumber,
        title: t.title,
        lastActivityNote: t.record.lastActivityNote,
      });
    }
  }
  return { counts, running };
}

export function formatBacklogText(tickets: BacklogTicket[]): string {
  if (tickets.length === 0) return "Backlog is empty.";
  return tickets
    .map((t) => `#${t.number} [${t.status}]${t.priority ? ` ${t.priority}` : ""} ${t.title}`)
    .join("\n");
}

export function formatBoardStatusText(summary: BoardSummary): string {
  const countLines = Object.entries(summary.counts)
    .map(([status, count]) => `${status}: ${count}`)
    .join("\n");
  const runningLines =
    summary.running.length === 0
      ? "None"
      : summary.running
          .map((t) => `${t.project}#${t.issueNumber} "${t.title}"${t.lastActivityNote ? ` — ${t.lastActivityNote}` : ""}`)
          .join("\n");
  return `${countLines || "No tickets"}\n\nRunning:\n${runningLines}`;
}

async function fleetFetch(fleetUrl: string, path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${fleetUrl}${path}`, init);
  } catch {
    throw new Error(`Could not reach the fleet daemon at ${fleetUrl}. Is the fleet daemon running at ${fleetUrl}?`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fleet daemon returned ${res.status} for ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

export async function fileTicket(fleetUrl: string, project: string, input: FileTicketInput): Promise<FileTicketResult> {
  const data = (await fleetFetch(fleetUrl, `/api/projects/${project}/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildFileTicketRequest(input)),
  })) as FileTicketResult;
  return { number: data.number, url: data.url };
}

export async function queryBacklog(fleetUrl: string, project: string): Promise<BacklogTicket[]> {
  const data = (await fleetFetch(fleetUrl, `/api/projects/${project}/backlog`)) as { tickets: BacklogTicket[] };
  return data.tickets;
}

export async function fetchBoardStatus(fleetUrl: string): Promise<BoardSummary> {
  const data = (await fleetFetch(fleetUrl, `/api/board`)) as { tickets: BoardTicketLike[] };
  return summarizeBoard(data.tickets);
}
