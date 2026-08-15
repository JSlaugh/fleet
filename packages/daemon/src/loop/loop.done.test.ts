import type { ClosedTicketRecord } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { synthesizeDoneTickets } from "./board.ts";
import { makeRecord } from "../test-support.ts";

function closed(issueNumber: number, closedAt: string, patch: Partial<ClosedTicketRecord> = {}): ClosedTicketRecord {
  const record = makeRecord({
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    branch: `fleet/${issueNumber}`,
    worktreePath: `/tmp/wt/${issueNumber}`,
    status: "review",
    costUsd: 1,
    prUrl: `https://github.com/acme/alpha/pull/${issueNumber}`,
  });
  return { ...record, closedAt, prState: "MERGED", ...patch };
}

const projects = [{ name: "alpha", githubRepo: "acme/alpha" }];

describe("synthesizeDoneTickets", () => {
  it("synthesizes a board ticket for each history entry", () => {
    const tickets = synthesizeDoneTickets([closed(1, "2026-01-01T00:00:00.000Z")], projects);
    const ticket = tickets[0]!;
    expect(ticket).toMatchObject({
      project: "alpha",
      issueNumber: 1,
      title: "issue 1",
      url: "https://github.com/acme/alpha/issues/1",
      status: "done",
      priority: null,
      isPlan: false,
    });
    expect(ticket.record?.prUrl).toBe("https://github.com/acme/alpha/pull/1");
  });

  it("orders newest first", () => {
    const history = [
      closed(1, "2026-01-01T00:00:00.000Z"),
      closed(2, "2026-01-03T00:00:00.000Z"),
      closed(3, "2026-01-02T00:00:00.000Z"),
    ];
    expect(synthesizeDoneTickets(history, projects).map((t) => t.issueNumber)).toEqual([2, 3, 1]);
  });

  it("caps at the given limit", () => {
    const history = Array.from({ length: 8 }, (_, i) => closed(i, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`));
    expect(synthesizeDoneTickets(history, projects, 5)).toHaveLength(5);
  });

  it("defaults to a limit of 5", () => {
    const history = Array.from({ length: 8 }, (_, i) => closed(i, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`));
    expect(synthesizeDoneTickets(history, projects)).toHaveLength(5);
  });

  it("falls back to an empty url when the project is unknown", () => {
    const tickets = synthesizeDoneTickets([closed(1, "2026-01-01T00:00:00.000Z", { project: "unknown" })], projects);
    expect(tickets[0]!.url).toBe("");
  });
});
