import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, ProjectConfig } from "@fleet/shared";
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

function makeApp(projects: ProjectConfig[] = [project]) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-pause-"));
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
    usageWindowHours: 5,
    budgetLightThreshold: 0.85,
    dataDir,
    projects,
  };
  const approvals = { request: vi.fn(), list: vi.fn(() => []) } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, state };
}

describe("POST /api/daemon/pause", () => {
  it("pauses the daemon and is reflected on GET /api/board", async () => {
    const { app, state } = makeApp();

    const res = await app.request("/api/daemon/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paused: true });
    expect(state.getPaused()).toBe(true);

    const board = (await (await app.request("/api/board")).json()) as { paused: boolean };
    expect(board.paused).toBe(true);
  });

  it("resumes the daemon", async () => {
    const { app, state } = makeApp();
    state.setPaused(true);

    const res = await app.request("/api/daemon/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });

    expect(res.status).toBe(200);
    expect(state.getPaused()).toBe(false);
  });

  it("rejects a non-boolean paused value", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/daemon/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: "yes" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/board", () => {
  it("includes paused, pausedUntil, pausedProjects, and runningCount", async () => {
    const { app } = makeApp();

    const board = (await (await app.request("/api/board")).json()) as {
      paused: boolean;
      pausedUntil?: string;
      pausedProjects: string[];
      runningCount: number;
    };

    expect(board.paused).toBe(false);
    expect(board.pausedUntil).toBeUndefined();
    expect(board.pausedProjects).toEqual([]);
    expect(board.runningCount).toBe(0);
  });
});

describe("POST /api/projects/:name/pause", () => {
  const beta: ProjectConfig = { ...project, name: "beta", repoPath: "/repo/beta", githubRepo: "acme/beta" };

  it("pauses one project and is reflected on GET /api/board without affecting the other", async () => {
    const { app, state } = makeApp([project, beta]);

    const res = await app.request("/api/projects/alpha/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paused: true });
    expect(state.isProjectPaused("alpha")).toBe(true);
    expect(state.isProjectPaused("beta")).toBe(false);

    const board = (await (await app.request("/api/board")).json()) as { pausedProjects: string[] };
    expect(board.pausedProjects).toEqual(["alpha"]);
  });

  it("resumes a paused project", async () => {
    const { app, state } = makeApp();
    state.setProjectPaused("alpha", true);

    const res = await app.request("/api/projects/alpha/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });

    expect(res.status).toBe(200);
    expect(state.isProjectPaused("alpha")).toBe(false);
  });

  it("rejects a non-boolean paused value", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/projects/alpha/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: "yes" }),
    });

    expect(res.status).toBe(400);
  });

  it("404s for an unknown project", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/projects/nope/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });

    expect(res.status).toBe(404);
  });
});
