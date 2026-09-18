import { createIssue, ensureFleetLabels, listFleetIssues, type RepoRef } from "@fleet/github";
import {
  CreateTicketSchema,
  SECTION_LABELS,
  boardStatusFromLabels,
  bodyWithDependsOn,
  labelsForNewTicket,
  lintIntakeBody,
  priorityOf,
  type CreateTicketInput,
} from "@fleet/shared";

/**
 * The GitHub-backed half of the MCP. Labels are fleet's source of truth and the
 * daemon only polls for them, so an issue filed here is a fully valid ticket
 * whether or not any daemon is running. It runs the exact contract the
 * daemon's REST route runs (`CreateTicketSchema` → `labelsForNewTicket` →
 * `bodyWithDependsOn` → `createIssue`), so the two paths cannot drift.
 */

export type Priority = "p1" | "p2" | "p3";

export function priorityLabel(priority: Priority | undefined): CreateTicketInput["priority"] {
  return priority ? `fleet:${priority}` : undefined;
}

export interface FileTicketInput {
  title: string;
  body: string;
  priority?: Priority;
  ready?: boolean;
  dependsOn?: number[];
}

/** The MCP tool's short-form input as the shared contract's input. */
export function toCreateTicketInput(input: FileTicketInput): CreateTicketInput {
  return CreateTicketSchema.parse({
    title: input.title,
    body: input.body,
    priority: priorityLabel(input.priority),
    ...(input.ready !== undefined ? { ready: input.ready } : {}),
    ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
  });
}

/**
 * The same gate the daemon's claim path and the dashboard form apply, run
 * before any `gh` call so a malformed ticket never reaches GitHub. Only a
 * ready ticket is linted: `ready: false` files for human curation, where a
 * rough body is the point.
 */
export function intakeProblem(input: CreateTicketInput): string | undefined {
  if (!input.ready) return undefined;
  const missing = lintIntakeBody(input.body, { isPlan: false });
  if (missing.length === 0) return undefined;
  return (
    `Ticket body is missing required section${missing.length === 1 ? "" : "s"}: ${missing.map((s) => SECTION_LABELS[s]).join(", ")}. ` +
    "Add them as markdown headings (## Problem, ## Acceptance criteria, ## Verification) and try again, or file with ready: false for human curation."
  );
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

export interface TicketGateway {
  fileTicket(input: FileTicketInput): Promise<FileTicketResult>;
  queryBacklog(): Promise<BacklogTicket[]>;
}

export class GithubTickets implements TicketGateway {
  private readonly repo: RepoRef;
  private labelsReady?: Promise<void>;

  constructor(repo: string) {
    this.repo = { githubRepo: repo };
  }

  /** `gh label create --force` is idempotent; running it once per process removes the last manual setup step for a fresh repo. */
  private ensureLabels(): Promise<void> {
    this.labelsReady ??= ensureFleetLabels(this.repo).catch((err) => {
      this.labelsReady = undefined;
      throw err;
    });
    return this.labelsReady;
  }

  async fileTicket(input: FileTicketInput): Promise<FileTicketResult> {
    const parsed = toCreateTicketInput(input);
    const problem = intakeProblem(parsed);
    if (problem) throw new Error(problem);
    await this.ensureLabels();
    return createIssue(this.repo, {
      title: parsed.title,
      body: bodyWithDependsOn(parsed.body, parsed.dependsOn),
      labels: labelsForNewTicket(parsed),
    });
  }

  /** Live from GitHub (the daemon's board cache can lag a poll cycle), open issues on the board only — the same set the daemon's backlog route shows. */
  async queryBacklog(): Promise<BacklogTicket[]> {
    const issues = await listFleetIssues(this.repo);
    const tickets: BacklogTicket[] = [];
    for (const issue of issues) {
      const status = boardStatusFromLabels(issue.labels);
      if (!status) continue;
      tickets.push({ number: issue.number, title: issue.title, status, priority: priorityOf(issue.labels), url: issue.url });
    }
    return tickets;
  }
}

export function formatBacklogText(tickets: BacklogTicket[]): string {
  if (tickets.length === 0) return "Backlog is empty.";
  return tickets
    .map((t) => `#${t.number} [${t.status}]${t.priority ? ` ${t.priority}` : ""} ${t.title}`)
    .join("\n");
}
