import type { FleetConfig } from "@fleet/shared";
import type { DaemonEvent } from "../store/db.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCtx, makeFleetConfig, makeProject, makeRecord } from "../test-support.ts";
import { checkDigestSchedule, computeDigest, type DigestInput, getDigest, resolveDigestTime, shouldSendDigest } from "./digest.ts";
import type { LoopContext } from "./context.ts";

const NOW = new Date("2026-01-02T12:00:00.000Z");
const projects = [{ name: "alpha", githubRepo: "acme/alpha" }];

function baseInput(patch: Partial<DigestInput> = {}): DigestInput {
  return { tickets: [], events: [], projects, windowHours: 24, now: NOW, ...patch };
}

function event(patch: Partial<DaemonEvent> = {}): DaemonEvent {
  return { at: "2026-01-02T06:00:00.000Z", type: "auto-merged", project: "alpha", issueNumber: 5, data: {}, ...patch };
}

describe("computeDigest", () => {
  it("returns zeroed output for an empty window", () => {
    const digest = computeDigest(baseInput());
    expect(digest.projects).toEqual([]);
    expect(digest.totalSpendUsd).toBe(0);
    expect(digest.gateHolds).toEqual([]);
    expect(digest.budget).toBeUndefined();
  });

  it("buckets a review-status ticket touched in-window as completed", () => {
    const record = makeRecord({ status: "review", prUrl: "https://github.com/acme/alpha/pull/9", lastActivityAt: "2026-01-02T06:00:00.000Z", costUsd: 2 });
    const digest = computeDigest(baseInput({ tickets: [record] }));
    expect(digest.projects).toHaveLength(1);
    expect(digest.projects[0]?.completed).toEqual([
      { project: "alpha", issueNumber: 62, title: "issue 62", url: "https://github.com/acme/alpha/issues/62", prUrl: record.prUrl, costUsd: 2 },
    ]);
    expect(digest.projects[0]?.spendUsd).toBe(2);
  });

  it("buckets needs-input as blocked, with the reason from lastSummary", () => {
    const record = makeRecord({ status: "needs-input", lastSummary: "need an API key", lastActivityAt: "2026-01-02T06:00:00.000Z" });
    const digest = computeDigest(baseInput({ tickets: [record] }));
    expect(digest.projects[0]?.blocked[0]).toMatchObject({ issueNumber: 62, reason: "need an API key" });
  });

  it("buckets failed as failed, with the reason from lastSummary", () => {
    const record = makeRecord({ status: "failed", lastSummary: "timed out", lastActivityAt: "2026-01-02T06:00:00.000Z" });
    const digest = computeDigest(baseInput({ tickets: [record] }));
    expect(digest.projects[0]?.failed[0]).toMatchObject({ issueNumber: 62, reason: "timed out" });
  });

  it("ignores a ticket whose lastActivityAt falls outside the window", () => {
    const record = makeRecord({ status: "review", lastActivityAt: "2026-01-01T00:00:00.000Z" });
    const digest = computeDigest(baseInput({ tickets: [record] }));
    expect(digest.projects).toEqual([]);
  });

  it("ignores running/stalled/restarting tickets — no bucket claims them", () => {
    const record = makeRecord({ status: "running", lastActivityAt: "2026-01-02T06:00:00.000Z" });
    const digest = computeDigest(baseInput({ tickets: [record] }));
    expect(digest.projects).toEqual([]);
  });

  it("sources auto-merged tickets from an in-window auto-merged event", () => {
    const digest = computeDigest(
      baseInput({ events: [event({ type: "auto-merged", data: { title: "Fix the bug", prUrl: "https://github.com/acme/alpha/pull/5", costUsd: 3 } })] }),
    );
    expect(digest.projects[0]?.autoMerged).toEqual([
      { project: "alpha", issueNumber: 5, title: "Fix the bug", url: "https://github.com/acme/alpha/issues/5", prUrl: "https://github.com/acme/alpha/pull/5", costUsd: 3 },
    ]);
    expect(digest.projects[0]?.spendUsd).toBe(3);
  });

  it("sources stale releases from an in-window stale-claim-released event", () => {
    const digest = computeDigest(
      baseInput({ events: [event({ type: "stale-claim-released", data: { title: "Flaky ticket", owners: ["bob"] } })] }),
    );
    expect(digest.projects[0]?.staleReleases).toEqual([
      { project: "alpha", issueNumber: 5, title: "Flaky ticket", url: "https://github.com/acme/alpha/issues/5", owners: ["bob"], at: "2026-01-02T06:00:00.000Z" },
    ]);
  });

  it.each([
    ["gate-hold-budget", "budget"],
    ["gate-hold-work-hours", "work-hours"],
    ["gate-hold-plan-limit", "plan-limit"],
  ] as const)("sources a %s event as a %s gate hold", (type, gate) => {
    const digest = computeDigest(baseInput({ events: [event({ type, project: "alpha", issueNumber: undefined, data: { detail: "held" } })] }));
    expect(digest.gateHolds).toEqual([{ gate, at: "2026-01-02T06:00:00.000Z", project: "alpha", detail: "held" }]);
  });

  it("excludes an event outside the window", () => {
    const digest = computeDigest(baseInput({ events: [event({ at: "2025-12-01T00:00:00.000Z" })] }));
    expect(digest.projects).toEqual([]);
  });

  it("reports totalSpendUsd/budget from the input, independent of per-project spend", () => {
    const digest = computeDigest(baseInput({ spentUsd: 4.5, budgetUsd: 10, budgetWindowHours: 5 }));
    expect(digest.totalSpendUsd).toBe(4.5);
    expect(digest.budget).toEqual({ budgetUsd: 10, windowHours: 5 });
  });

  it("sorts projects alphabetically", () => {
    const digest = computeDigest(
      baseInput({
        projects: [{ name: "zeta", githubRepo: "acme/zeta" }, { name: "alpha", githubRepo: "acme/alpha" }],
        tickets: [
          makeRecord({ project: "zeta", status: "review", lastActivityAt: "2026-01-02T06:00:00.000Z" }),
          makeRecord({ project: "alpha", status: "review", lastActivityAt: "2026-01-02T06:00:00.000Z" }),
        ],
      }),
    );
    expect(digest.projects.map((p) => p.project)).toEqual(["alpha", "zeta"]);
  });
});

describe("resolveDigestTime", () => {
  it("prefers notifications.digestTime", () => {
    expect(resolveDigestTime({ notifications: { discordUrl: "https://x", digestTime: "10:00" }, workHoursReserve: { workStart: "09:00", days: ["mon"], reserveHours: 1 } })).toBe(
      "10:00",
    );
  });

  it("falls back to workHoursReserve.workStart when digestTime is unset", () => {
    expect(resolveDigestTime({ workHoursReserve: { workStart: "09:00", days: ["mon"], reserveHours: 1 } })).toBe("09:00");
  });

  it("is undefined when neither is set", () => {
    expect(resolveDigestTime({})).toBeUndefined();
  });
});

describe("shouldSendDigest", () => {
  // digestTime is local machine time (same convention as workHoursReserve.workStart), so every
  // instant here is built from local Date components rather than a UTC ISO string.
  it("is false before today's scheduled time", () => {
    expect(shouldSendDigest(new Date(2026, 0, 2, 8, 0, 0), "09:00", undefined)).toBe(false);
  });

  it("is true at/after today's scheduled time when never sent", () => {
    expect(shouldSendDigest(new Date(2026, 0, 2, 9, 0, 0), "09:00", undefined)).toBe(true);
    expect(shouldSendDigest(new Date(2026, 0, 2, 9, 5, 0), "09:00", undefined)).toBe(true);
  });

  it("is true when the last send was before today's scheduled time (day boundary)", () => {
    const lastSentAt = new Date(2026, 0, 1, 9, 1, 0).toISOString();
    expect(shouldSendDigest(new Date(2026, 0, 2, 9, 5, 0), "09:00", lastSentAt)).toBe(true);
  });

  it("is false when already sent at/after today's scheduled time", () => {
    expect(shouldSendDigest(new Date(2026, 0, 2, 9, 5, 0), "09:00", new Date(2026, 0, 2, 9, 0, 0).toISOString())).toBe(false);
    expect(shouldSendDigest(new Date(2026, 0, 2, 9, 5, 0), "09:00", new Date(2026, 0, 2, 9, 1, 0).toISOString())).toBe(false);
  });
});

describe("getDigest", () => {
  it("gathers live tickets and events into a computed digest", () => {
    const project = makeProject();
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(makeRecord({ status: "review", lastActivityAt: new Date().toISOString() }));
    ctx.state.appendEvent("auto-merged", { project: project.name, issueNumber: 7, data: { title: "Merged one" } });

    const digest = getDigest(ctx, 24);

    expect(digest.projects[0]?.completed).toHaveLength(1);
    expect(digest.projects[0]?.autoMerged).toHaveLength(1);
  });

  it("reports budget/spend only when windowBudgetUsd is configured", () => {
    const ctx = makeCtx();
    ctx.state.appendSpend(2, ctx.config.usageWindowHours);
    const withoutBudget = getDigest(ctx, 24);
    expect(withoutBudget.budget).toBeUndefined();

    const ctxWithBudget = makeCtx({ config: makeFleetConfig({ windowBudgetUsd: 10, usageWindowHours: 5 }) });
    ctxWithBudget.state.appendSpend(2, 5);
    const withBudget = getDigest(ctxWithBudget, 24);
    expect(withBudget.budget).toEqual({ budgetUsd: 10, windowHours: 5 });
    expect(withBudget.totalSpendUsd).toBeCloseTo(2);
  });
});

describe("checkDigestSchedule", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // digestTime is local machine time, so every instant here is built from local Date
  // components rather than a UTC ISO string — see shouldSendDigest's tests above.
  function ctxAt(localDate: Date, configPatch: Partial<FleetConfig> = {}, ctxPatch: Partial<LoopContext> = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(localDate);
    return makeCtx({ config: makeFleetConfig(configPatch), ...ctxPatch });
  }

  it("does nothing without a discordUrl configured, even with a resolvable digestTime", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const ctx = ctxAt(new Date(2026, 0, 2, 9, 5, 0), { workHoursReserve: { workStart: "09:00", days: ["fri"], reserveHours: 1 } });
    await checkDigestSchedule(ctx);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing when no digestTime is resolvable", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const ctx = ctxAt(new Date(2026, 0, 2, 9, 5, 0), { notifications: { discordUrl: "https://discord.example/webhook" } });
    await checkDigestSchedule(ctx);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing before today's digestTime", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const ctx = ctxAt(new Date(2026, 0, 2, 8, 0, 0), { notifications: { discordUrl: "https://discord.example/webhook", digestTime: "09:00" } });
    await checkDigestSchedule(ctx);
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.state.getLastDigestSentAt()).toBeUndefined();
  });

  it("posts once digestTime has passed and records lastDigestSentAt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const now = new Date(2026, 0, 2, 9, 5, 0);
    const ctx = ctxAt(now, { notifications: { discordUrl: "https://discord.example/webhook", digestTime: "09:00" } });
    await checkDigestSchedule(ctx);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx.state.getLastDigestSentAt()).toBe(now.toISOString());
  });

  it("does not double-send on a later cycle the same day", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = ctxAt(new Date(2026, 0, 2, 9, 5, 0), { notifications: { discordUrl: "https://discord.example/webhook", digestTime: "09:00" } });
    await checkDigestSchedule(ctx);
    vi.setSystemTime(new Date(2026, 0, 2, 9, 30, 0));
    await checkDigestSchedule(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends again the next day, restart-safe (lastDigestSentAt survives across calls)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = ctxAt(new Date(2026, 0, 2, 9, 5, 0), { notifications: { discordUrl: "https://discord.example/webhook", digestTime: "09:00" } });
    await checkDigestSchedule(ctx);
    vi.setSystemTime(new Date(2026, 0, 3, 9, 5, 0));
    await checkDigestSchedule(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing under --dry-run, and does not record a send", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const ctx = ctxAt(
      new Date(2026, 0, 2, 9, 5, 0),
      { notifications: { discordUrl: "https://discord.example/webhook", digestTime: "09:00" } },
      { dryRun: true },
    );
    await checkDigestSchedule(ctx);
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.state.getLastDigestSentAt()).toBeUndefined();
  });

  it("does nothing under --once", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const ctx = ctxAt(
      new Date(2026, 0, 2, 9, 5, 0),
      { notifications: { discordUrl: "https://discord.example/webhook", digestTime: "09:00" } },
      { once: true },
    );
    await checkDigestSchedule(ctx);
    expect(fetch).not.toHaveBeenCalled();
  });
});
