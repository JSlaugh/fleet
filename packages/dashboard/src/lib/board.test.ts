import { describe, expect, it } from "vitest";
import type { BoardTicket, TicketRecord } from "@fleet/shared";
import { groupByEpic, projectRollup } from "./board.ts";

function ticket(patch: Partial<BoardTicket> & { issueNumber: number }): BoardTicket {
  return {
    project: "alpha",
    title: `issue ${patch.issueNumber}`,
    url: `https://github.com/acme/alpha/issues/${patch.issueNumber}`,
    status: "ready",
    priority: null,
    type: null,
    isPlan: false,
    ...patch,
  };
}

describe("groupByEpic", () => {
  it("leaves unrelated tickets in their original relative order", () => {
    const list = [ticket({ issueNumber: 1 }), ticket({ issueNumber: 2 }), ticket({ issueNumber: 3 })];
    expect(groupByEpic(list).map((t) => t.issueNumber)).toEqual([1, 2, 3]);
  });

  it("clusters the epic ticket itself alongside its children", () => {
    const epic = ticket({ issueNumber: 7, isPlan: true, epicProgress: { closed: 1, total: 2 } });
    const child1 = ticket({ issueNumber: 41, epicNumber: 7 });
    const child2 = ticket({ issueNumber: 42, epicNumber: 7 });
    // Interleaved with an unrelated ticket, as they'd appear in a real column.
    const list = [child1, ticket({ issueNumber: 99 }), epic, child2];

    const grouped = groupByEpic(list);

    const epicIndex = grouped.findIndex((t) => t.issueNumber === 7);
    const child1Index = grouped.findIndex((t) => t.issueNumber === 41);
    const child2Index = grouped.findIndex((t) => t.issueNumber === 42);
    // All three land in one contiguous run.
    const span = [epicIndex, child1Index, child2Index].sort((a, b) => a - b);
    expect(span.at(-1)! - span.at(0)!).toBe(2);
  });

  it("clusters even when the epic ticket appears before any of its children", () => {
    const epic = ticket({ issueNumber: 7, isPlan: true, epicProgress: { closed: 0, total: 1 } });
    const child = ticket({ issueNumber: 41, epicNumber: 7 });
    const grouped = groupByEpic([epic, ticket({ issueNumber: 99 }), child]);

    const epicIndex = grouped.findIndex((t) => t.issueNumber === 7);
    const childIndex = grouped.findIndex((t) => t.issueNumber === 41);
    expect(Math.abs(epicIndex - childIndex)).toBe(1);
  });

  it("does not cluster a plan ticket with no filed children (no epicProgress) into anything", () => {
    const bareplan = ticket({ issueNumber: 7, isPlan: true });
    const unrelated = ticket({ issueNumber: 8 });
    expect(groupByEpic([bareplan, unrelated]).map((t) => t.issueNumber)).toEqual([7, 8]);
  });
});

describe("projectRollup", () => {
  it("counts only the named project's tickets per column, ignoring other projects", () => {
    const list = [
      ticket({ issueNumber: 1, project: "alpha", status: "ready" }),
      ticket({ issueNumber: 2, project: "alpha", status: "ready" }),
      ticket({ issueNumber: 3, project: "alpha", status: "review" }),
      ticket({ issueNumber: 4, project: "beta", status: "ready" }),
    ];

    const rollup = projectRollup("alpha", list, 0);

    expect(rollup.project).toBe("alpha");
    expect(rollup.counts.ready).toBe(2);
    expect(rollup.counts.review).toBe(1);
    expect(rollup.counts["in-progress"]).toBe(0);
    expect(rollup.counts.done).toBe(0);
  });

  it("needs attention when a ticket is needs-input, when a record failed, or when approvals are pending — otherwise not", () => {
    expect(projectRollup("alpha", [ticket({ issueNumber: 1, project: "alpha", status: "ready" })], 0).needsAttention).toBe(false);
    expect(projectRollup("alpha", [ticket({ issueNumber: 1, project: "alpha", status: "needs-input" })], 0).needsAttention).toBe(true);
    expect(
      projectRollup(
        "alpha",
        [ticket({ issueNumber: 1, project: "alpha", status: "review", record: { status: "failed" } as unknown as TicketRecord })],
        0,
      ).needsAttention,
    ).toBe(true);
    expect(projectRollup("alpha", [ticket({ issueNumber: 1, project: "alpha", status: "ready" })], 2).needsAttention).toBe(true);
  });
});
