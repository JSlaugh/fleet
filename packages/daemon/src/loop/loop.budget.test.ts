import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, TicketRecord } from "@fleet/shared";
import { afterEach, describe, expect, it } from "vitest";
import { budgetStatus, computeBudgetGate, recordSpend } from "./budget.ts";
import type { LoopContext } from "./context.ts";
import { StateStore } from "../store/state.ts";

const dataDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-budget-"));
  dataDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(overrides: Partial<FleetConfig> = {}): FleetConfig {
  return {
    pollIntervalSeconds: 60,
    dashboardPort: 4400,
    worktreeRoot: "/tmp/wt",
    stalledAfterMinutes: 10,
    ticketTimeoutMinutes: 30,
    approvalTimeoutMinutes: 10,
    replyWaitMinutes: 60,
    limitResumeSlackMinutes: 5,
    limitDefaultBackoffMinutes: 300,
    usageWindowHours: 5,
    budgetLightThreshold: 0.85,
    dataDir: ".fleet",
    projects: [],
    ...overrides,
  };
}

function ctxWith(state: StateStore, configOverrides: Partial<FleetConfig> = {}): LoopContext {
  return { config: config(configOverrides), state } as unknown as LoopContext;
}

function ticket(patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber: 1,
    issueTitle: "issue 1",
    branch: "fleet/1",
    worktreePath: "/tmp/wt/1",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 0,
    ...patch,
  };
}

describe("computeBudgetGate", () => {
  it("is 'none' with zero spend when windowBudgetUsd is unset — feature off", () => {
    const ctx = ctxWith(new StateStore(tempDataDir()));
    expect(computeBudgetGate(ctx)).toEqual({ level: "none", spentUsd: 0, windowHours: 5 });
  });

  it("is 'none' under the light threshold", () => {
    const state = new StateStore(tempDataDir());
    state.appendSpend(5, 5);
    const gate = computeBudgetGate(ctxWith(state, { windowBudgetUsd: 10 }));
    expect(gate).toEqual({ level: "none", spentUsd: 5, budgetUsd: 10, windowHours: 5 });
  });

  it("is 'light-only' once spend reaches the light threshold", () => {
    const state = new StateStore(tempDataDir());
    state.appendSpend(8.5, 5); // == 0.85 * 10
    expect(computeBudgetGate(ctxWith(state, { windowBudgetUsd: 10 })).level).toBe("light-only");
  });

  it("is 'blocked' once spend reaches the budget", () => {
    const state = new StateStore(tempDataDir());
    state.appendSpend(10, 5);
    expect(computeBudgetGate(ctxWith(state, { windowBudgetUsd: 10 })).level).toBe("blocked");
  });

  it("ignores spend that has aged out of the window", () => {
    const dataDir = tempDataDir();
    writeFileSync(
      join(dataDir, "state.json"),
      JSON.stringify({
        tickets: [],
        spendLedger: [{ at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), usd: 10 }],
      }),
    );
    const state = new StateStore(dataDir);
    const gate = computeBudgetGate(ctxWith(state, { windowBudgetUsd: 10 })); // default 5h window
    expect(gate).toEqual({ level: "none", spentUsd: 0, budgetUsd: 10, windowHours: 5 });
  });
});

describe("budgetStatus", () => {
  it("is undefined when the feature is off, so the board hides it entirely", () => {
    expect(budgetStatus(ctxWith(new StateStore(tempDataDir())))).toBeUndefined();
  });

  it("reflects spend/budget/gate when the feature is on", () => {
    const state = new StateStore(tempDataDir());
    state.appendSpend(9, 5);
    expect(budgetStatus(ctxWith(state, { windowBudgetUsd: 10 }))).toEqual({
      spentUsd: 9,
      budgetUsd: 10,
      windowHours: 5,
      gate: "light-only",
    });
  });
});

describe("recordSpend", () => {
  it("is a no-op when the feature is off, so the ledger never grows unused", () => {
    const state = new StateStore(tempDataDir());
    recordSpend(ctxWith(state), "alpha", 1, 5);
    expect(state.getWindowSpend(5)).toBe(0);
  });

  it("appends only the delta versus the ticket's currently recorded cost", () => {
    const state = new StateStore(tempDataDir());
    state.upsert(ticket({ costUsd: 2 }));
    const ctx = ctxWith(state, { windowBudgetUsd: 100 });

    recordSpend(ctx, "alpha", 1, 3); // +1
    expect(state.getWindowSpend(5)).toBeCloseTo(1);
  });

  it("ignores a duplicate write of the same total (e.g. the redundant finally-block write after the last turn)", () => {
    const state = new StateStore(tempDataDir());
    state.upsert(ticket({ costUsd: 3 }));
    const ctx = ctxWith(state, { windowBudgetUsd: 100 });

    recordSpend(ctx, "alpha", 1, 3);
    expect(state.getWindowSpend(5)).toBe(0);
  });

  it("never double-counts a per-turn write followed by a machine-review write against the same running total", () => {
    const state = new StateStore(tempDataDir());
    state.upsert(ticket({ costUsd: 0 }));
    const ctx = ctxWith(state, { windowBudgetUsd: 100 });

    // Turn 1: session cost climbs 0 -> 2, mirroring supervise()'s per-turn write.
    recordSpend(ctx, "alpha", 1, 2);
    state.update("alpha", 1, { costUsd: 2 });

    // Machine review adds 0.3 on top of the ticket's recorded total.
    recordSpend(ctx, "alpha", 1, 2.3);
    state.update("alpha", 1, { costUsd: 2.3 });

    // Turn 2 (post machine-review fix round): total climbs from 2.3 to 4.3.
    recordSpend(ctx, "alpha", 1, 4.3);
    state.update("alpha", 1, { costUsd: 4.3 });

    expect(state.getWindowSpend(5)).toBeCloseTo(4.3);
  });
});
