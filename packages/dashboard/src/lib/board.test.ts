import { describe, expect, it } from "vitest";
import type { BoardTicket } from "@fleet/shared";
import { groupByEpic } from "./board.ts";

function ticket(patch: Partial<BoardTicket> & { issueNumber: number }): BoardTicket {
  return {
    project: "alpha",
    title: `issue ${patch.issueNumber}`,
    url: `https://github.com/acme/alpha/issues/${patch.issueNumber}`,
    status: "ready",
    priority: null,
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
