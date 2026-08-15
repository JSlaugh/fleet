import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClosedTicketRecord, FleetConfig, HistoryResponse, ProjectConfig, TicketRecord } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";
import { HistoryStore, StateStore } from "../store/state.ts";

const projectAlpha: ProjectConfig = {
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

const projectBeta: ProjectConfig = { ...projectAlpha, name: "beta", repoPath: "/repo/beta", githubRepo: "acme/beta" };

function closedRecord(patch: Partial<ClosedTicketRecord> = {}): ClosedTicketRecord {
  const record: TicketRecord = {
    project: "alpha",
    issueNumber: 1,
    issueTitle: "A ticket",
    branch: "fleet/1",
    worktreePath: "/tmp/wt/1",
    status: "review",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:30:00.000Z",
    costUsd: 1,
  };
  return { ...record, closedAt: "2026-01-01T01:00:00.000Z", prState: "MERGED", ...patch };
}

function makeApp(seedHistory: ClosedTicketRecord[] = []) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-history-"));
  const history = new HistoryStore(dataDir);
  for (const record of seedHistory) history.add(record);
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
    projects: [projectAlpha, projectBeta],
  };
  const approvals = { request: vi.fn(), list: vi.fn(() => []) } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  return createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
}

async function fetchHistory(app: ReturnType<typeof makeApp>, qs = "") {
  const res = await app.request(`/api/history${qs}`);
  return { status: res.status, body: (await res.json()) as HistoryResponse };
}

describe("GET /api/history", () => {
  it("returns an empty page with zeroed aggregates when nothing has been archived", async () => {
    const app = makeApp();
    const { status, body } = await fetchHistory(app);
    expect(status).toBe(200);
    expect(body.records).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.aggregates.count).toBe(0);
    expect(body.aggregates.meanCostUsd).toBe(0);
  });

  it("returns records newest-first with issue URLs attached", async () => {
    const app = makeApp([
      closedRecord({ issueNumber: 1, closedAt: "2026-01-01T00:00:00.000Z" }),
      closedRecord({ issueNumber: 2, closedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    const { status, body } = await fetchHistory(app);
    expect(status).toBe(200);
    expect(body.records.map((r) => r.issueNumber)).toEqual([2, 1]);
    expect(body.records[0]?.url).toBe("https://github.com/acme/alpha/issues/2");
    expect(body.total).toBe(2);
  });

  it("filters by project", async () => {
    const app = makeApp([
      closedRecord({ project: "alpha", issueNumber: 1 }),
      closedRecord({ project: "beta", issueNumber: 2 }),
    ]);
    const { body } = await fetchHistory(app, "?project=beta");
    expect(body.records.map((r) => r.issueNumber)).toEqual([2]);
    expect(body.total).toBe(1);
    expect(body.aggregates.count).toBe(1);
  });

  it("paginates with limit/offset while total reflects the full filtered set", async () => {
    const app = makeApp([
      closedRecord({ issueNumber: 1, closedAt: "2026-01-01T00:00:00.000Z" }),
      closedRecord({ issueNumber: 2, closedAt: "2026-01-02T00:00:00.000Z" }),
      closedRecord({ issueNumber: 3, closedAt: "2026-01-03T00:00:00.000Z" }),
    ]);
    const { body } = await fetchHistory(app, "?limit=1&offset=1");
    expect(body.records.map((r) => r.issueNumber)).toEqual([2]);
    expect(body.total).toBe(3);
    expect(body.aggregates.count).toBe(3);
  });

  it("filters by since/until on closedAt", async () => {
    const app = makeApp([
      closedRecord({ issueNumber: 1, closedAt: "2026-01-01T00:00:00.000Z" }),
      closedRecord({ issueNumber: 2, closedAt: "2026-01-05T00:00:00.000Z" }),
    ]);
    const { body } = await fetchHistory(app, "?since=2026-01-03T00:00:00.000Z");
    expect(body.records.map((r) => r.issueNumber)).toEqual([2]);
  });

  it("400s on a non-positive limit", async () => {
    const app = makeApp();
    const res = await app.request("/api/history?limit=0");
    expect(res.status).toBe(400);
  });

  it("400s on a negative offset", async () => {
    const app = makeApp();
    const res = await app.request("/api/history?offset=-1");
    expect(res.status).toBe(400);
  });
});
