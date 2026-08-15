import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";
import { StateStore } from "../store/state.ts";

vi.mock("../github/github.ts", () => ({
  markReady: vi.fn(async () => {}),
  upsertStatusComment: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

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

function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    status: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 3,
    ...patch,
  };
}

function makeApp(seed?: TicketRecord) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-restart-"));
  const state = new StateStore(dataDir);
  if (seed) state.upsert(seed);
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
    usageWindowHours: 5,
    budgetLightThreshold: 0.85,
    dataDir,
    projects: [project],
  };
  const approvals = { request: vi.fn(), list: vi.fn(() => []) } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const internals = loop as unknown as { running: Map<string, Promise<void>> };
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, state, internals };
}

const post = (app: ReturnType<typeof makeApp>["app"], path: string) => app.request(path, { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/tickets/:project/:issue/restart", () => {
  it("resets a known ticket to fleet:ready", async () => {
    const { app, state } = makeApp(record());

    const res = await post(app, "/api/tickets/alpha/7/restart");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(github.markReady).toHaveBeenCalledWith(project, 7);
    expect(state.get("alpha", 7)?.status).toBe("restarting");
  });

  it("404s on an unknown project", async () => {
    const { app } = makeApp(record());
    const res = await post(app, "/api/tickets/nope/7/restart");
    expect(res.status).toBe(404);
    expect(github.markReady).not.toHaveBeenCalled();
  });

  it("404s on a ticket the daemon has never heard of", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/tickets/alpha/999/restart");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not a known fleet ticket/);
  });

  it("409s when the ticket is mid-transition (in flight, no live session to abort)", async () => {
    const { app, internals } = makeApp(record());
    internals.running.set("alpha#7", new Promise<void>(() => {}));

    const res = await post(app, "/api/tickets/alpha/7/restart");

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mid-transition/);
    expect(github.markReady).not.toHaveBeenCalled();
  });
});
