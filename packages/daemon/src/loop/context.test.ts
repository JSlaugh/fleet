import { describe, expect, it } from "vitest";
import { countActive } from "./context.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const YIELD_MS = 30 * 60_000;
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const approval = (issueNumber: number, createdAt: string, project = "alpha") => ({ project, issueNumber, createdAt });

describe("countActive", () => {
  it("excludes a ticket whose approval has been pending longer than the yield window", () => {
    expect(countActive(["alpha#1", "alpha#2"], [approval(1, minutesAgo(31))], "alpha", YIELD_MS, NOW)).toEqual({ active: 1, yielded: 1 });
  });

  it("still counts a ticket whose approval is younger than the window", () => {
    expect(countActive(["alpha#1"], [approval(1, minutesAgo(29))], "alpha", YIELD_MS, NOW)).toEqual({ active: 1, yielded: 0 });
  });

  it("counts a ticket with no pending approval", () => {
    expect(countActive(["alpha#1"], [], "alpha", YIELD_MS, NOW)).toEqual({ active: 1, yielded: 0 });
  });

  it("uses the ticket's oldest pending approval", () => {
    const approvals = [approval(1, minutesAgo(5)), approval(1, minutesAgo(45))];
    expect(countActive(["alpha#1"], approvals, "alpha", YIELD_MS, NOW)).toEqual({ active: 0, yielded: 1 });
  });

  it("never lets another project's approvals or running tickets affect the count", () => {
    const approvals = [approval(1, minutesAgo(60), "beta")];
    expect(countActive(["alpha#1", "beta#1", "beta#2"], approvals, "alpha", YIELD_MS, NOW)).toEqual({ active: 1, yielded: 0 });
  });

  it("ignores a pending approval for a ticket that isn't running", () => {
    expect(countActive(["alpha#2"], [approval(1, minutesAgo(60))], "alpha", YIELD_MS, NOW)).toEqual({ active: 1, yielded: 0 });
  });
});
