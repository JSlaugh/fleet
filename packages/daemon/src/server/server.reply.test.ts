import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";
import { StateStore } from "../store/state.ts";

vi.mock("../loop/runner.ts", () => ({
  resumeTicket: vi.fn(async () => {}),
}));

const runnerMod = await import("../loop/runner.ts");

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
  autoMerge: false,
  mergeMethod: "squash",
};

function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 3,
    ...patch,
  };
}

/** A `FleetLoop` over a throwaway data dir, plus handles on its private maps for seeding live/waiting sessions. */
function makeApp(seed?: TicketRecord) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-reply-"));
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
  const internals = loop as unknown as {
    live: Map<string, { send: (message: string) => void }>;
    replyWaiters: Map<string, (message: string | undefined) => void>;
  };
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, internals };
}

const post = (app: ReturnType<typeof makeApp>["app"], path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/tickets/:project/:issue/reply", () => {
  it("400s on a missing message", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/tickets/alpha/7/reply", {});
    expect(res.status).toBe(400);
  });

  it("400s on a blank message", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/tickets/alpha/7/reply", { message: "   " });
    expect(res.status).toBe(400);
  });

  it("steers a session parked awaiting a reply", async () => {
    const { app, internals } = makeApp(record({ status: "needs-input" }));
    const received: (string | undefined)[] = [];
    internals.replyWaiters.set("alpha#7", (message) => received.push(message));

    const res = await post(app, "/api/tickets/alpha/7/reply", { message: "keep going" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "steered" });
    expect(received).toEqual(["keep going"]);
  });

  it("steers a message into an already-live session", async () => {
    const { app, internals } = makeApp(record());
    const send = vi.fn();
    internals.live.set("alpha#7", { send });

    const res = await post(app, "/api/tickets/alpha/7/reply", { message: "hello" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "steered" });
    expect(send).toHaveBeenCalledWith("hello");
  });

  it("resumes a cold ticket with a recorded session id", async () => {
    const { app } = makeApp(record({ status: "needs-input", sessionId: "sess-7" }));

    const res = await post(app, "/api/tickets/alpha/7/reply", { message: "resume please" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "resumed" });
    expect(runnerMod.resumeTicket).toHaveBeenCalledWith(expect.anything(), project, expect.objectContaining({ issueNumber: 7 }), "resume please");
  });

  it("409s when no session is recorded for the ticket", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/tickets/alpha/7/reply", { message: "hello?" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no session recorded/);
  });

  it("409s for an unknown project (this route has no 404 path — it relies on loop.reply throwing)", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/tickets/nope/7/reply", { message: "hello?" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown project/);
  });
});
