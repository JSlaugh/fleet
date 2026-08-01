import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClosedTicketRecord, FleetConfig, ProjectConfig, TicketDetail, TicketRecord } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "./approvals.ts";
import { FleetLoop } from "./loop.ts";
import { createApp } from "./server.ts";
import { HistoryStore, StateStore } from "./state.ts";

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

function closedRecord(patch: Partial<ClosedTicketRecord> = {}): ClosedTicketRecord {
  const record: TicketRecord = {
    project: "alpha",
    issueNumber: 9,
    issueTitle: "Archived ticket",
    branch: "fleet/9",
    worktreePath: "/tmp/wt/9",
    status: "review",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T01:00:00.000Z",
    costUsd: 4.5,
    prUrl: "https://github.com/acme/alpha/pull/9",
    lastSummary: "Did the thing.",
  };
  return { ...record, closedAt: "2026-01-02T00:00:00.000Z", prState: "MERGED", ...patch };
}

/** Wires a real `FleetLoop` + `StateStore` over a throwaway data dir, with optional live/archived records seeded in. */
function makeApp(opts: { seedHistory?: ClosedTicketRecord; seedState?: TicketRecord } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-detail-"));
  if (opts.seedHistory) new HistoryStore(dataDir).add(opts.seedHistory);
  const state = new StateStore(dataDir);
  if (opts.seedState) state.upsert(opts.seedState);
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
  return createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
}

describe("GET /api/tickets/:project/:issue", () => {
  it("falls back to the archived history record for a Done ticket", async () => {
    const app = makeApp({ seedHistory: closedRecord() });
    const res = await app.request("/api/tickets/alpha/9");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TicketDetail;
    expect(body.record).toMatchObject({
      prUrl: "https://github.com/acme/alpha/pull/9",
      costUsd: 4.5,
      lastSummary: "Did the thing.",
      prState: "MERGED",
    });
  });

  it("prefers the live state record over an archived one for the same ticket", async () => {
    const app = makeApp({
      seedHistory: closedRecord({ costUsd: 99 }),
      seedState: {
        project: "alpha",
        issueNumber: 9,
        issueTitle: "Archived ticket",
        branch: "fleet/9",
        worktreePath: "/tmp/wt/9",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T01:00:00.000Z",
        costUsd: 1,
      },
    });
    const res = await app.request("/api/tickets/alpha/9");
    const body = (await res.json()) as TicketDetail;
    expect(body.record?.costUsd).toBe(1);
  });

  it("404s on an unknown project", async () => {
    const app = makeApp();
    const res = await app.request("/api/tickets/nope/9");
    expect(res.status).toBe(404);
  });

  it("404s on a non-numeric issue number", async () => {
    const app = makeApp();
    const res = await app.request("/api/tickets/alpha/abc");
    expect(res.status).toBe(404);
  });

  it("returns an empty-ish detail for a known project with no record for that issue", async () => {
    const app = makeApp();
    const res = await app.request("/api/tickets/alpha/123");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TicketDetail;
    expect(body.record).toBeUndefined();
    expect(body.canRestart).toBe(false);
    expect(body.canReply).toBe(false);
  });

  it("offers reply and restart for a review-status ticket with a cold sessionId", async () => {
    // No live session and nothing in flight — this is the case the dashboard's
    // old hardcoded status list got wrong: `review` wasn't in RESTARTABLE and
    // wasn't in the reply gate, even though the server would accept both.
    const app = makeApp({
      seedState: {
        project: "alpha",
        issueNumber: 9,
        issueTitle: "In review",
        branch: "fleet/9",
        worktreePath: "/tmp/wt/9",
        status: "review",
        sessionId: "sess-9",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T01:00:00.000Z",
        costUsd: 1,
      },
    });
    const res = await app.request("/api/tickets/alpha/9");
    const body = (await res.json()) as TicketDetail;
    expect(body.canRestart).toBe(true);
    expect(body.canReply).toBe(true);
  });

  it("withholds reply for a done ticket even though its archived record kept a sessionId", async () => {
    // reply() always re-reads live state and never consults history, so a
    // closed ticket's leftover sessionId (kept verbatim by cleanupFinished)
    // must not leak into canReply — the ticket has no live state record at all.
    const app = makeApp({ seedHistory: closedRecord({ sessionId: "sess-9" }) });
    const res = await app.request("/api/tickets/alpha/9");
    const body = (await res.json()) as TicketDetail;
    expect(body.canReply).toBe(false);
  });

  it("withholds reply for a ticket with no recorded session", async () => {
    const app = makeApp({
      seedState: {
        project: "alpha",
        issueNumber: 9,
        issueTitle: "Fresh",
        branch: "fleet/9",
        worktreePath: "/tmp/wt/9",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T01:00:00.000Z",
        costUsd: 0,
      },
    });
    const res = await app.request("/api/tickets/alpha/9");
    const body = (await res.json()) as TicketDetail;
    expect(body.canReply).toBe(false);
    expect(body.canRestart).toBe(true);
  });
});
