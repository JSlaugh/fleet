import { join } from "node:path";
import type { ProjectConfig } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState, postJson } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

const project = makeProject();

function makeApp(projects: ProjectConfig[] = [project]) {
  const { dataDir, state } = makeTempState("fleet-server-pause-");
  const config = makeFleetConfig({ dataDir, projects });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, state };
}

describe("POST /api/daemon/pause", () => {
  it("pauses the daemon and is reflected on GET /api/board", async () => {
    const { app, state } = makeApp();

    const res = await postJson(app, "/api/daemon/pause", { paused: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paused: true });
    expect(state.getPaused()).toBe(true);

    const board = (await (await app.request("/api/board")).json()) as { paused: boolean };
    expect(board.paused).toBe(true);
  });

  it("resumes the daemon", async () => {
    const { app, state } = makeApp();
    state.setPaused(true);

    const res = await postJson(app, "/api/daemon/pause", { paused: false });

    expect(res.status).toBe(200);
    expect(state.getPaused()).toBe(false);
  });

  it("rejects a non-boolean paused value", async () => {
    const { app } = makeApp();

    const res = await postJson(app, "/api/daemon/pause", { paused: "yes" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/board", () => {
  it("includes paused, pausedUntil, pausedProjects, dormantProjects, and runningCount", async () => {
    const { app } = makeApp();

    const board = (await (await app.request("/api/board")).json()) as {
      paused: boolean;
      pausedUntil?: string;
      pausedProjects: string[];
      dormantProjects: string[];
      runningCount: number;
    };

    expect(board.paused).toBe(false);
    expect(board.pausedUntil).toBeUndefined();
    expect(board.pausedProjects).toEqual([]);
    expect(board.dormantProjects).toEqual([]);
    expect(board.runningCount).toBe(0);
  });
});

describe("POST /api/projects/:name/pause", () => {
  const beta = makeProject({ name: "beta", repoPath: "/repo/beta", githubRepo: "acme/beta" });

  it("pauses one project and is reflected on GET /api/board without affecting the other", async () => {
    const { app, state } = makeApp([project, beta]);

    const res = await postJson(app, "/api/projects/alpha/pause", { paused: true });

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

    const res = await postJson(app, "/api/projects/alpha/pause", { paused: false });

    expect(res.status).toBe(200);
    expect(state.isProjectPaused("alpha")).toBe(false);
  });

  it("rejects a non-boolean paused value", async () => {
    const { app } = makeApp();

    const res = await postJson(app, "/api/projects/alpha/pause", { paused: "yes" });

    expect(res.status).toBe(400);
  });

  it("404s for an unknown project", async () => {
    const { app } = makeApp();

    const res = await postJson(app, "/api/projects/nope/pause", { paused: true });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/projects/:name/dormant", () => {
  const beta = makeProject({ name: "beta", repoPath: "/repo/beta", githubRepo: "acme/beta" });

  it("pins one project dormant and is reflected on GET /api/board without affecting the other", async () => {
    const { app, state } = makeApp([project, beta]);

    const res = await postJson(app, "/api/projects/alpha/dormant", { dormant: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dormant: true });
    expect(state.isProjectDormant("alpha")).toBe(true);
    expect(state.isProjectDormant("beta")).toBe(false);

    const board = (await (await app.request("/api/board")).json()) as { dormantProjects: string[] };
    expect(board.dormantProjects).toEqual(["alpha"]);
  });

  it("pins a dormant project back to active", async () => {
    const { app, state } = makeApp();
    state.setProjectDormant("alpha", true);

    const res = await postJson(app, "/api/projects/alpha/dormant", { dormant: false });

    expect(res.status).toBe(200);
    expect(state.isProjectDormant("alpha")).toBe(false);
  });

  it("rejects a non-boolean dormant value", async () => {
    const { app } = makeApp();

    const res = await postJson(app, "/api/projects/alpha/dormant", { dormant: "yes" });

    expect(res.status).toBe(400);
  });

  it("404s for an unknown project", async () => {
    const { app } = makeApp();

    const res = await postJson(app, "/api/projects/nope/dormant", { dormant: true });

    expect(res.status).toBe(404);
  });
});
