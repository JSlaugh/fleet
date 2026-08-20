import { join } from "node:path";
import type { JournalEntry, ProjectConfig, TicketReport } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { insertJournalEntry, openDatabase } from "../store/db.ts";
import { createApp } from "./server.ts";

const project: ProjectConfig = makeProject();

function makeApp() {
  const { dataDir, state } = makeTempState("fleet-server-report-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, dataDir };
}

/** Inserts rows straight into `journal_entries`, bypassing `Journal.append`'s `v`/`ts` defaulting, so tests can assert exact aggregation from known entry shapes. */
function writeJournal(dataDir: string, issueNumber: number, entries: JournalEntry[]): void {
  const db = openDatabase(dataDir);
  for (const entry of entries) insertJournalEntry(db, "alpha", issueNumber, entry);
}

async function fetchReport(app: ReturnType<typeof makeApp>["app"], issueNumber: number) {
  const res = await app.request(`/api/tickets/alpha/${issueNumber}/report`);
  return { status: res.status, body: (await res.json()) as TicketReport };
}

describe("GET /api/tickets/:project/:issue/report", () => {
  it("404s for an unknown project", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/tickets/nope/1/report");
    expect(res.status).toBe(404);
  });

  it("404s for a non-integer issue number", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/tickets/alpha/abc/report");
    expect(res.status).toBe(404);
  });

  it("returns a zeroed report when no journal entries exist yet", async () => {
    const { app } = makeApp();
    const { status, body } = await fetchReport(app, 1);
    expect(status).toBe(200);
    expect(body).toEqual({
      toolCounts: {},
      toolErrorCounts: {},
      errorCount: 0,
      segments: [],
      totals: { toolCalls: 0, errors: 0, turns: 0, durationMs: 0, costUsd: 0 },
      bashDeniedCount: 0,
      approvalLatency: { count: 0, totalWaitMs: 0, maxWaitMs: 0 },
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      machineReview: undefined,
    });
  });

  it("counts tool uses from legacy tools-only entries and zeroes error/turn fields", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 2, [
      { ts: "t0", type: "fleet", event: "claimed" },
      { ts: "t1", type: "assistant", tools: ["Bash", "Read"] },
      { ts: "t2", type: "assistant", tools: ["Bash"] },
      { ts: "t3", type: "result", subtype: "success", costUsd: 0.5 },
    ]);

    const { status, body } = await fetchReport(app, 2);

    expect(status).toBe(200);
    expect(body.toolCounts).toEqual({ Bash: 2, Read: 1 });
    expect(body.toolErrorCounts).toEqual({});
    expect(body.errorCount).toBe(0);
    expect(body.segments).toEqual([{ numTurns: null, durationMs: null, costUsd: 0.5 }]);
    expect(body.totals).toEqual({ toolCalls: 3, errors: 0, turns: 0, durationMs: 0, costUsd: 0.5 });
  });

  it("aggregates enriched toolCalls/toolResults/numTurns/durationMs across two segments", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 3, [
      { ts: "t0", type: "fleet", event: "claimed" },
      {
        ts: "t1",
        type: "assistant",
        toolCalls: [
          { id: "tu_1", name: "Bash" },
          { id: "tu_2", name: "Read" },
        ],
      },
      { ts: "t2", type: "user", toolResults: [{ id: "tu_1", isError: true }, { id: "tu_2" }] },
      { ts: "t3", type: "result", subtype: "success", costUsd: 0.2, numTurns: 4, durationMs: 15000 },
      { ts: "t4", type: "fleet", event: "resumed" },
      {
        ts: "t5",
        type: "assistant",
        toolCalls: [{ id: "tu_3", name: "Bash" }],
      },
      { ts: "t6", type: "user", toolResults: [{ id: "tu_3", isError: true }] },
      { ts: "t7", type: "result", subtype: "success", costUsd: 0.3, numTurns: 2, durationMs: 5000 },
    ]);

    const { status, body } = await fetchReport(app, 3);

    expect(status).toBe(200);
    expect(body.toolCounts).toEqual({ Bash: 2, Read: 1 });
    expect(body.toolErrorCounts).toEqual({ Bash: 2 });
    expect(body.errorCount).toBe(2);
    expect(body.segments).toEqual([
      { numTurns: 4, durationMs: 15000, costUsd: 0.2 },
      { numTurns: 2, durationMs: 5000, costUsd: 0.3 },
    ]);
    expect(body.totals).toEqual({ toolCalls: 3, errors: 2, turns: 6, durationMs: 20000, costUsd: 0.5 });
  });

  it("excludes machine-review sub-session entries from tool counts and segments", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 5, [
      { ts: "t0", type: "fleet", event: "claimed" },
      { ts: "t1", type: "assistant", tools: ["Bash"] },
      { ts: "t2", type: "result", subtype: "success", costUsd: 0.1 },
      { ts: "t3", type: "fleet", event: "machine-review-started", session: "machine-review" },
      { ts: "t4", type: "assistant", tools: ["Read", "Grep"], session: "machine-review" },
      { ts: "t5", type: "result", subtype: "success", costUsd: 0.05, session: "machine-review" },
    ]);

    const { status, body } = await fetchReport(app, 5);

    expect(status).toBe(200);
    expect(body.toolCounts).toEqual({ Bash: 1 });
    expect(body.segments).toEqual([{ numTurns: null, durationMs: null, costUsd: 0.1 }]);
    expect(body.totals).toEqual({ toolCalls: 1, errors: 0, turns: 0, durationMs: 0, costUsd: 0.1 });
  });

  it("counts bash-denied firings and rolls up approval-decided wait times", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 6, [
      { ts: "t0", type: "fleet", event: "claimed" },
      { ts: "t1", type: "fleet", event: "bash-denied", command: "git push", reason: "forbidden" },
      { ts: "t2", type: "fleet", event: "bash-denied", command: "gh pr create", reason: "forbidden" },
      { ts: "t3", type: "fleet", event: "approval-decided", toolName: "Bash", outcome: "allowed", waitMs: 1000 },
      { ts: "t4", type: "fleet", event: "approval-decided", toolName: "Write", outcome: "denied", waitMs: 5000 },
      { ts: "t5", type: "result", subtype: "success", costUsd: 0.1 },
    ]);

    const { body } = await fetchReport(app, 6);

    expect(body.bashDeniedCount).toBe(2);
    expect(body.approvalLatency).toEqual({ count: 2, totalWaitMs: 6000, maxWaitMs: 5000 });
  });

  it("sums per-message cache-read/cache-creation tokens, excluding the machine-review sub-session", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 7, [
      { ts: "t0", type: "fleet", event: "claimed" },
      { ts: "t1", type: "assistant", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20 } },
      { ts: "t2", type: "assistant", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 50, cacheCreationTokens: 0 } },
      { ts: "t3", type: "result", subtype: "success", costUsd: 0.1 },
      { ts: "t4", type: "fleet", event: "machine-review-started" },
      { ts: "t5", type: "assistant", usage: { cacheReadTokens: 999 }, session: "machine-review" },
      { ts: "t6", type: "result", subtype: "success", session: "machine-review" },
    ]);

    const { body } = await fetchReport(app, 7);

    expect(body.cacheReadTokens).toBe(150);
    expect(body.cacheCreationTokens).toBe(20);
  });

  it("excludes the plan-review sub-session's own usage from cache token totals", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 12, [
      { ts: "t0", type: "fleet", event: "claimed" },
      { ts: "t1", type: "assistant", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20 } },
      { ts: "t2", type: "result", subtype: "success", costUsd: 0.1 },
      { ts: "t3", type: "fleet", event: "plan-review-started" },
      { ts: "t4", type: "assistant", usage: { cacheReadTokens: 999, cacheCreationTokens: 999 }, session: "plan-review" },
      { ts: "t5", type: "result", subtype: "success", session: "plan-review" },
    ]);

    const { body } = await fetchReport(app, 12);

    expect(body.cacheReadTokens).toBe(100);
    expect(body.cacheCreationTokens).toBe(20);
  });

  it("reports a passed machine review", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 8, [
      { ts: "t0", type: "fleet", event: "claimed" },
      { ts: "t1", type: "fleet", event: "machine-review-started", model: "claude-sonnet-5" },
      { ts: "t2", type: "fleet", event: "machine-review-passed", summary: "looks good" },
    ]);

    const { body } = await fetchReport(app, 8);

    expect(body.machineReview).toEqual({
      kind: "code",
      outcome: "passed",
      model: "claude-sonnet-5",
      findings: [],
      errorSubtype: undefined,
    });
  });

  it("reports a plan review's findings", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 9, [
      { ts: "t0", type: "fleet", event: "claimed" },
      { ts: "t1", type: "fleet", event: "plan-review-started", model: "claude-haiku-4-5" },
      {
        ts: "t2",
        type: "fleet",
        event: "plan-review-findings",
        count: 1,
        findings: [{ ticketIndex: 0, severity: "major", summary: "too vague", detail: "needs acceptance criteria" }],
      },
    ]);

    const { body } = await fetchReport(app, 9);

    expect(body.machineReview).toEqual({
      kind: "plan",
      outcome: "findings",
      model: "claude-haiku-4-5",
      findings: [{ ticketIndex: 0, severity: "major", summary: "too vague", detail: "needs acceptance criteria" }],
      errorSubtype: undefined,
    });
  });

  it("reports a machine review that failed open", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 10, [
      { ts: "t0", type: "fleet", event: "claimed" },
      { ts: "t1", type: "fleet", event: "machine-review-started" },
      { ts: "t2", type: "fleet", event: "machine-review-error", errorSubtype: "timed out after 8 minutes" },
    ]);

    const { body } = await fetchReport(app, 10);

    expect(body.machineReview).toEqual({
      kind: "code",
      outcome: "error",
      model: undefined,
      findings: [],
      errorSubtype: "timed out after 8 minutes",
    });
  });

  it("omits machineReview entirely when no review ran", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 11, [
      { ts: "t0", type: "fleet", event: "claimed" },
      { ts: "t1", type: "result", subtype: "success", costUsd: 0.1 },
    ]);

    const { body } = await fetchReport(app, 11);

    expect(body.machineReview).toBeUndefined();
  });
});
