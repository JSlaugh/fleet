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
import { DaemonUnreachableError, fileTicketViaDaemon } from "./daemon.ts";

/**
 * Ticket filing and backlog reads. Labels are fleet's source of truth and the
 * daemon only polls for them, so an issue filed straight to GitHub is a fully
 * valid ticket whether or not any daemon is running. It runs the exact contract
 * the daemon's REST route runs (`CreateTicketSchema` → `labelsForNewTicket` →
 * `bodyWithDependsOn` → `createIssue`), so the two paths cannot drift.
 *
 * When a daemon is configured, filing still goes through it (`DaemonFirstTickets`):
 * the issue is then opened by the daemon's `gh` identity, which the claim loop's
 * contributor floor trusts and which can always apply labels. Filing as the
 * MCP user instead would silently strand tickets from users without push access
 * — GitHub drops their labels, and the floor skips their issues.
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
 * ready ticket is linted: `ready: false` files into `fleet:backlog` for human
 * curation, where a rough body is the point.
 */
export function intakeProblem(input: CreateTicketInput): string | undefined {
  if (!input.ready) return undefined;
  const missing = lintIntakeBody(input.body, { isPlan: false });
  if (missing.length === 0) return undefined;
  return (
    `Ticket body is missing required section${missing.length === 1 ? "" : "s"}: ${missing.map((s) => SECTION_LABELS[s]).join(", ")}. ` +
    "Add them as markdown headings (## Problem, ## Acceptance criteria, ## Verification) and try again, or file with ready: false to park it in the backlog for human curation."
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

  constructor(
    repo: string,
    private readonly warn: (line: string) => void = (l) => console.error(l),
    /** False for a project with `intakeLint: false` — the claim path wouldn't lint it either. */
    readonly lint = true,
  ) {
    this.repo = { githubRepo: repo };
  }

  /**
   * `gh label create --force` is idempotent; running it once per process
   * removes the last manual setup step for a fresh repo. Best-effort: a user
   * without write access can't create labels, and that must not stop the
   * ticket itself from being filed. A failure is retried on the next filing.
   */
  private ensureLabels(): Promise<void> {
    this.labelsReady ??= ensureFleetLabels(this.repo).catch((err) => {
      this.labelsReady = undefined;
      this.warn(`fleet mcp: could not ensure fleet labels in ${this.repo.githubRepo} — filing anyway: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.labelsReady;
  }

  async fileTicket(input: FileTicketInput): Promise<FileTicketResult> {
    return this.fileParsed(checkedInput(input, this.lint));
  }

  /** Files an already-validated ticket; `DaemonFirstTickets` falls back to this. */
  async fileParsed(parsed: CreateTicketInput): Promise<FileTicketResult> {
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

function checkedInput(input: FileTicketInput, lint: boolean): CreateTicketInput {
  const parsed = toCreateTicketInput(input);
  const problem = lint ? intakeProblem(parsed) : undefined;
  if (problem) throw new Error(problem);
  return parsed;
}

/**
 * Files through the daemon when one is configured and a project is known, so
 * the daemon's identity opens the issue (see the module comment). Falls back
 * to GitHub directly only when the daemon doesn't answer at all — an error the
 * daemon *returns* is surfaced as-is. Backlog reads stay live from GitHub.
 */
export class DaemonFirstTickets implements TicketGateway {
  constructor(
    private readonly github: GithubTickets,
    private readonly daemon: { url: string; project: string },
    private readonly warn: (line: string) => void = (l) => console.error(l),
  ) {}

  async fileTicket(input: FileTicketInput): Promise<FileTicketResult> {
    const parsed = checkedInput(input, this.github.lint);
    try {
      return await fileTicketViaDaemon(this.daemon.url, this.daemon.project, parsed);
    } catch (err) {
      if (!(err instanceof DaemonUnreachableError)) throw err;
      this.warn(`fleet mcp: ${err.message} — filing straight to GitHub as the local gh user instead`);
      return this.github.fileParsed(parsed);
    }
  }

  queryBacklog(): Promise<BacklogTicket[]> {
    return this.github.queryBacklog();
  }
}

export function formatBacklogText(tickets: BacklogTicket[]): string {
  if (tickets.length === 0) return "Backlog is empty.";
  return tickets
    .map((t) => `#${t.number} [${t.status}]${t.priority ? ` ${t.priority}` : ""} ${t.title}`)
    .join("\n");
}
