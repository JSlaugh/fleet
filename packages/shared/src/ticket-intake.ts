import { z } from "zod";
import { FLEET_LABELS, PRIORITY_LABELS } from "./labels.ts";

/**
 * The one ticket-filing contract. Every path that creates a fleet issue — the
 * dashboard's ticket form via the daemon's REST route, and the MCP server's
 * `fleet_file_ticket` talking to GitHub directly — runs these same three
 * pieces, so an issue is shaped identically no matter where it was filed.
 *
 * `ready: false` files the issue into `fleet:backlog` instead of `fleet:ready`:
 * visible on the board, but held until a human releases it.
 */
export const CreateTicketSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  priority: z.enum(PRIORITY_LABELS).optional(),
  ready: z.boolean().default(true),
  dependsOn: z.array(z.number().int().positive()).optional(),
});

export type CreateTicketInput = z.infer<typeof CreateTicketSchema>;

export function labelsForNewTicket(input: CreateTicketInput): string[] {
  const labels: string[] = [];
  labels.push(input.ready ? FLEET_LABELS.ready : FLEET_LABELS.backlog);
  if (input.priority) labels.push(input.priority);
  return labels;
}

/**
 * Reads dependencies from two possible spots in an issue body, unioning both: a
 * `Depends-on: #12, #14` line typed anywhere (case-insensitive key, comma/space
 * separated), and the `### Depends on\n\n#12 #14` section GitHub renders for the
 * `depends-on` field of the fleet-task issue form. Entries that aren't a bare
 * `#<digits>` token are ignored rather than rejecting the whole match, so a stray
 * typo in the list doesn't drop every other dependency.
 */
export function parseDependsOn(body: string): number[] {
  const lineMatch = /^\s*depends-on\s*:\s*(.+)$/im.exec(body);
  const sectionMatch = /^###\s*depends on\s*\r?\n+([^\n]*)/im.exec(body);
  const raw = [lineMatch?.[1], sectionMatch?.[1]].filter((s): s is string => s !== undefined).join(" ");
  const numbers = raw
    .split(/[\s,]+/)
    .map((token) => /^#(\d+)$/.exec(token.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1] ?? ""))
    .filter((n) => !Number.isNaN(n));
  return [...new Set(numbers)];
}

/** Appends a `Depends-on: #...` line `parseDependsOn` will parse back out. */
export function bodyWithDependsOn(body: string, dependsOn: number[] | undefined): string {
  if (!dependsOn || dependsOn.length === 0) return body;
  const line = `Depends-on: ${dependsOn.map((n) => `#${n}`).join(", ")}`;
  return body.trim().length > 0 ? `${body}\n\n${line}` : line;
}
