import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, ProjectConfig, TicketReport } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";
import { StateStore } from "../store/state.ts";

const project: ProjectConfig = {
  name: "alpha",
  repoPath: "/repo/alpha",
  githubRepo: "acme/alpha",
  defaultBranch: "main",
  maxConcurrent: 1,
  maxInReview: 3,
  planChildrenReady: false,
  autoElevateOnFailure: true,
  autoAddressReviews: true,
  machineReview: false,
};

function makeApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-report-"));
  const state = new StateStore(dataDir);
  const config: FleetConfig = {
    pollIntervalSeconds: 60,
    dashboardPort: 4400,
    worktreeRoot: "/tmp/wt",
    stalledAfterMinutes: 10,
    ticketTimeoutMinutes: 30,
    approvalTimeoutMinutes: 10,
    replyWaitMinutes: 60,
    limitResumeSlackMinutes: 5,
    limitDefaultBackoffMinutes: 300,
    dataDir,
    projects: [project],
  };
  const approvals = { request: vi.fn(), list: vi.fn(() => []) } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, dataDir };
}

function writeJournal(dataDir: string, issueNumber: number, lines: string[]): void {
  const dir = join(dataDir, "journals", "alpha");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${issueNumber}.jsonl`), lines.join("\n"));
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

  it("returns a zeroed report when no journal file exists yet", async () => {
    const { app } = makeApp();
    const { status, body } = await fetchReport(app, 1);
    expect(status).toBe(200);
    expect(body).toEqual({
      toolCounts: {},
      toolErrorCounts: {},
      errorCount: 0,
      segments: [],
      totals: { toolCalls: 0, errors: 0, turns: 0, durationMs: 0, costUsd: 0 },
    });
  });

  it("counts tool uses from legacy tools-only entries and zeroes error/turn fields", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 2, [
      JSON.stringify({ ts: "t0", type: "fleet", event: "claimed" }),
      JSON.stringify({ ts: "t1", type: "assistant", tools: ["Bash", "Read"] }),
      JSON.stringify({ ts: "t2", type: "assistant", tools: ["Bash"] }),
      JSON.stringify({ ts: "t3", type: "result", subtype: "success", costUsd: 0.5 }),
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
      JSON.stringify({ ts: "t0", type: "fleet", event: "claimed" }),
      JSON.stringify({
        ts: "t1",
        type: "assistant",
        toolCalls: [
          { id: "tu_1", name: "Bash" },
          { id: "tu_2", name: "Read" },
        ],
      }),
      JSON.stringify({ ts: "t2", type: "user", toolResults: [{ id: "tu_1", isError: true }, { id: "tu_2" }] }),
      JSON.stringify({ ts: "t3", type: "result", subtype: "success", costUsd: 0.2, numTurns: 4, durationMs: 15000 }),
      JSON.stringify({ ts: "t4", type: "fleet", event: "resumed" }),
      JSON.stringify({
        ts: "t5",
        type: "assistant",
        toolCalls: [{ id: "tu_3", name: "Bash" }],
      }),
      JSON.stringify({ ts: "t6", type: "user", toolResults: [{ id: "tu_3", isError: true }] }),
      JSON.stringify({ ts: "t7", type: "result", subtype: "success", costUsd: 0.3, numTurns: 2, durationMs: 5000 }),
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
      JSON.stringify({ ts: "t0", type: "fleet", event: "claimed" }),
      JSON.stringify({ ts: "t1", type: "assistant", tools: ["Bash"] }),
      JSON.stringify({ ts: "t2", type: "result", subtype: "success", costUsd: 0.1 }),
      JSON.stringify({ ts: "t3", type: "fleet", event: "machine-review-started", session: "machine-review" }),
      JSON.stringify({ ts: "t4", type: "assistant", tools: ["Read", "Grep"], session: "machine-review" }),
      JSON.stringify({ ts: "t5", type: "result", subtype: "success", costUsd: 0.05, session: "machine-review" }),
    ]);

    const { status, body } = await fetchReport(app, 5);

    expect(status).toBe(200);
    expect(body.toolCounts).toEqual({ Bash: 1 });
    expect(body.segments).toEqual([{ numTurns: null, durationMs: null, costUsd: 0.1 }]);
    expect(body.totals).toEqual({ toolCalls: 1, errors: 0, turns: 0, durationMs: 0, costUsd: 0.1 });
  });

  it("tolerates a malformed line by falling back to a zeroed report rather than throwing", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 4, [
      JSON.stringify({ ts: "t0", type: "fleet", event: "claimed" }),
      "{not valid json",
      JSON.stringify({ ts: "t2", type: "result", subtype: "success", costUsd: 1 }),
    ]);

    const { status, body } = await fetchReport(app, 4);

    expect(status).toBe(200);
    expect(body).toEqual({
      toolCounts: {},
      toolErrorCounts: {},
      errorCount: 0,
      segments: [],
      totals: { toolCalls: 0, errors: 0, turns: 0, durationMs: 0, costUsd: 0 },
    });
  });
});
