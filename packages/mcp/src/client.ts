export type Priority = "p1" | "p2" | "p3";

export function priorityLabel(priority: Priority | undefined): string | undefined {
  return priority ? `fleet:${priority}` : undefined;
}

export interface FileTicketInput {
  title: string;
  body: string;
  priority?: Priority;
  ready?: boolean;
  dependsOn?: number[];
}

/** Builds the JSON body for `POST /api/projects/:project/tickets` from the MCP tool's input. */
export function buildFileTicketRequest(input: FileTicketInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { title: input.title, body: input.body };
  const priority = priorityLabel(input.priority);
  if (priority) payload.priority = priority;
  if (input.ready !== undefined) payload.ready = input.ready;
  if (input.dependsOn !== undefined) payload.dependsOn = input.dependsOn;
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

// Local mirrors of the daemon's response shapes (this package deliberately
// doesn't depend on @fleet/shared): only the fields the formatters below read.

export interface HistoryRecordLike {
  project: string;
  issueNumber: number;
  issueTitle: string;
  closedAt: string;
  prState: "MERGED" | "CLOSED" | "NONE";
  costUsd: number;
  model?: string;
  isPlan?: boolean;
  timeToMergeMs?: number;
  humanPushedAfterOpen?: boolean;
  reviewRounds?: number;
  reviewCommentCount?: number;
  bashDeniedCount?: number;
  machineReviewOutcome?: string;
}

export interface HistoryAggregatesLike {
  count: number;
  totalCostUsd: number;
  meanCostUsd: number;
  meanDurationMs: number;
  prStateCounts: Record<string, number>;
  elevatedRate: number;
  lightRate: number;
  autoResumedRate: number;
  planRate: number;
  machineReviewOutcomeCounts: Record<string, number>;
}

export interface HistoryResponseLike {
  records: HistoryRecordLike[];
  total: number;
  aggregates: HistoryAggregatesLike;
}

export interface TicketReportLike {
  toolCounts: Record<string, number>;
  toolErrorCounts: Record<string, number>;
  segments: { numTurns: number | null; durationMs: number | null; costUsd: number }[];
  totals: { toolCalls: number; errors: number; turns: number; durationMs: number; costUsd: number };
  bashDeniedCount: number;
  approvalLatency: { count: number; totalWaitMs: number; maxWaitMs: number };
  machineReview?: {
    kind: "code" | "plan";
    outcome: string;
    findings: { file?: string; line?: number; ticketIndex?: number; severity?: string; summary?: string }[];
  };
}

export interface JournalEntryLike {
  ts: string;
  type: string;
  subtype?: string;
  text?: string;
  thinking?: string;
  event?: string;
  session?: string;
  costUsd?: number;
  numTurns?: number;
  toolCalls?: { name: string }[];
  toolResults?: { isError?: boolean }[];
}

export const DEFAULT_HISTORY_LIMIT = 10;

export interface HistoryQuery {
  project?: string;
  since?: string;
  until?: string;
  limit?: number;
}

/** Builds the `GET /api/history` path; `limit` defaults to `DEFAULT_HISTORY_LIMIT` (aggregates always cover the full filtered set regardless). */
export function buildHistoryPath(query: HistoryQuery): string {
  const params = new URLSearchParams();
  if (query.project) params.set("project", query.project);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  params.set("limit", String(query.limit ?? DEFAULT_HISTORY_LIMIT));
  return `/api/history?${params.toString()}`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function shortModel(model: string | undefined): string | undefined {
  return model?.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatHistoryRecordLine(r: HistoryRecordLike): string {
  const head =
    `${r.project}#${r.issueNumber} [${r.prState}${r.isPlan ? ", plan" : ""}]` +
    ` $${r.costUsd.toFixed(2)}${r.model ? ` ${shortModel(r.model)}` : ""}` +
    ` "${r.issueTitle}" closed ${r.closedAt.slice(0, 10)}`;
  const extras: string[] = [];
  if (r.timeToMergeMs !== undefined) extras.push(`merged in ${formatDurationMs(r.timeToMergeMs)}`);
  if (r.reviewRounds) extras.push(`${r.reviewRounds} review round${r.reviewRounds === 1 ? "" : "s"}`);
  if (r.reviewCommentCount) extras.push(`${r.reviewCommentCount} inline comment${r.reviewCommentCount === 1 ? "" : "s"}`);
  if (r.humanPushedAfterOpen) extras.push("human reworked");
  if (r.bashDeniedCount) extras.push(`${r.bashDeniedCount} bash denial${r.bashDeniedCount === 1 ? "" : "s"}`);
  if (r.machineReviewOutcome) extras.push(`machine review: ${r.machineReviewOutcome}`);
  return extras.length > 0 ? `${head} · ${extras.join(" · ")}` : head;
}

export function formatHistoryText(res: HistoryResponseLike): string {
  if (res.total === 0) return "No closed tickets match.";
  const a = res.aggregates;
  const reviewCounts = Object.entries(a.machineReviewOutcomeCounts)
    .filter(([, n]) => n > 0)
    .map(([outcome, n]) => `${outcome} ${n}`)
    .join(", ");
  return [
    ...res.records.map(formatHistoryRecordLine),
    "",
    `Aggregates over all ${a.count} matching ticket${a.count === 1 ? "" : "s"} (${res.records.length} shown):`,
    `PRs: ${a.prStateCounts.MERGED ?? 0} merged, ${a.prStateCounts.CLOSED ?? 0} closed unmerged, ${a.prStateCounts.NONE ?? 0} no PR`,
    `cost: $${a.totalCostUsd.toFixed(2)} total, $${a.meanCostUsd.toFixed(2)} mean · mean time to close ${formatDurationMs(a.meanDurationMs)}`,
    `rates: elevated ${percent(a.elevatedRate)}, light ${percent(a.lightRate)}, auto-resumed ${percent(a.autoResumedRate)}, plans ${percent(a.planRate)}`,
    `machine review: ${reviewCounts || "none recorded"}`,
  ].join("\n");
}

export function formatTicketReportText(report: TicketReportLike): string {
  const t = report.totals;
  if (t.toolCalls === 0 && report.segments.length === 0) {
    return "No journal data recorded for this ticket (yet). It may not have been claimed, or predates journaling.";
  }
  const lines: string[] = [
    `Totals: ${t.toolCalls} tool calls (${t.errors} errors) · ${t.turns} turns · ${formatDurationMs(t.durationMs)} · $${t.costUsd.toFixed(2)}`,
  ];
  if (report.segments.length > 0) {
    const segs = report.segments
      .map((s) => `${s.numTurns ?? "?"} turns/${s.durationMs !== null ? formatDurationMs(s.durationMs) : "?"}/$${s.costUsd.toFixed(2)}`)
      .join(", ");
    lines.push(`Sessions: ${report.segments.length} — ${segs}`);
  }
  const tools = Object.entries(report.toolCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, n]) => {
      const errors = report.toolErrorCounts[name];
      return `${name} ×${n}${errors ? ` (${errors} errors)` : ""}`;
    })
    .join(", ");
  if (tools) lines.push(`Tools: ${tools}`);
  if (report.bashDeniedCount > 0) lines.push(`Bash contract denials: ${report.bashDeniedCount}`);
  if (report.approvalLatency.count > 0) {
    const mean = Math.round(report.approvalLatency.totalWaitMs / report.approvalLatency.count);
    lines.push(
      `Approvals: ${report.approvalLatency.count} waited (mean ${formatDurationMs(mean)}, max ${formatDurationMs(report.approvalLatency.maxWaitMs)})`,
    );
  }
  if (report.machineReview) {
    const mr = report.machineReview;
    lines.push(`Machine review (${mr.kind}): ${mr.outcome}`);
    for (const f of mr.findings) {
      const where = f.file ? `${f.file}${f.line !== undefined ? `:${f.line}` : ""}` : f.ticketIndex !== undefined ? `ticket ${f.ticketIndex}` : "";
      lines.push(`  [${f.severity ?? "finding"}]${where ? ` ${where}` : ""}${f.summary ? ` — ${f.summary}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function formatJournalEntryLine(e: JournalEntryLike): string {
  const when = e.ts.replace("T", " ").slice(0, 16);
  const tag = e.session ? ` [${e.session}]` : "";
  let body: string;
  if (e.type === "fleet") {
    body = `fleet: ${e.event ?? "?"}${e.text ? ` — ${oneLine(e.text, 160)}` : ""}`;
  } else if (e.type === "result") {
    body = `result${e.subtype ? ` (${e.subtype})` : ""}${e.numTurns !== undefined ? ` — ${e.numTurns} turns` : ""}${e.costUsd !== undefined ? `, $${e.costUsd.toFixed(2)}` : ""}`;
  } else if (e.type === "assistant") {
    const toolNames = e.toolCalls?.map((c) => c.name).join(", ");
    const text = e.text ? oneLine(e.text, 200) : e.thinking ? `(thinking) ${oneLine(e.thinking, 200)}` : "";
    body = `assistant: ${text}${toolNames ? `${text ? " " : ""}→ ${toolNames}` : ""}`;
  } else if (e.type === "user" && e.toolResults?.length) {
    const errors = e.toolResults.filter((r) => r.isError).length;
    body = `tool results ×${e.toolResults.length}${errors ? ` (${errors} errors)` : ""}`;
  } else {
    body = `${e.type}${e.subtype ? ` (${e.subtype})` : ""}${e.text ? `: ${oneLine(e.text, 200)}` : ""}`;
  }
  return `${when}${tag} ${body}`;
}

export function formatJournalText(entries: JournalEntryLike[]): string {
  if (entries.length === 0) return "No journal entries for this ticket.";
  return entries.map(formatJournalEntryLine).join("\n");
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
  const data = (await fleetFetch(fleetUrl, `/api/projects/${encodeURIComponent(project)}/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildFileTicketRequest(input)),
  })) as FileTicketResult;
  return { number: data.number, url: data.url };
}

export async function queryBacklog(fleetUrl: string, project: string): Promise<BacklogTicket[]> {
  const data = (await fleetFetch(fleetUrl, `/api/projects/${encodeURIComponent(project)}/backlog`)) as { tickets: BacklogTicket[] };
  return data.tickets;
}

export async function fetchBoardStatus(fleetUrl: string): Promise<BoardSummary> {
  const data = (await fleetFetch(fleetUrl, `/api/board`)) as { tickets: BoardTicketLike[] };
  return summarizeBoard(data.tickets);
}

export async function fetchHistory(fleetUrl: string, query: HistoryQuery): Promise<HistoryResponseLike> {
  return (await fleetFetch(fleetUrl, buildHistoryPath(query))) as HistoryResponseLike;
}

export async function fetchTicketReport(fleetUrl: string, project: string, issue: number): Promise<TicketReportLike> {
  return (await fleetFetch(fleetUrl, `/api/tickets/${encodeURIComponent(project)}/${issue}/report`)) as TicketReportLike;
}

/** Reads the ticket detail's journal tail (the daemon returns up to its own cap; callers slice further). */
export async function fetchTicketJournal(fleetUrl: string, project: string, issue: number): Promise<JournalEntryLike[]> {
  const data = (await fleetFetch(fleetUrl, `/api/tickets/${encodeURIComponent(project)}/${issue}`)) as {
    journal?: JournalEntryLike[];
  };
  return data.journal ?? [];
}
