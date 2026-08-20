import { join } from "node:path";
import type { ProjectConfig } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState, postJson } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

vi.mock("../github/github.ts", () => ({
  setPriority: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

const project: ProjectConfig = makeProject();

function makeApp() {
  const { dataDir, state } = makeTempState("fleet-server-priority-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  return createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/tickets/:project/:issue/priority", () => {
  it("sets the priority and returns ok", async () => {
    const app = makeApp();
    const res = await postJson(app, "/api/tickets/alpha/7/priority", { priority: "fleet:p1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(github.setPriority).toHaveBeenCalledWith(project, 7, "fleet:p1");
  });

  it("accepts null to clear the priority", async () => {
    const app = makeApp();
    const res = await postJson(app, "/api/tickets/alpha/7/priority", { priority: null });
    expect(res.status).toBe(200);
    expect(github.setPriority).toHaveBeenCalledWith(project, 7, null);
  });

  it("404s on an unknown project", async () => {
    const app = makeApp();
    const res = await postJson(app, "/api/tickets/nope/7/priority", { priority: "fleet:p1" });
    expect(res.status).toBe(404);
    expect(github.setPriority).not.toHaveBeenCalled();
  });

  it("404s on a non-numeric issue number", async () => {
    const app = makeApp();
    const res = await postJson(app, "/api/tickets/alpha/abc/priority", { priority: "fleet:p1" });
    expect(res.status).toBe(404);
  });

  it("400s (not 500) on an empty body", async () => {
    const app = makeApp();

    const res = await app.request("/api/tickets/alpha/7/priority", { method: "POST" });

    expect(res.status).toBe(400);
    expect(github.setPriority).not.toHaveBeenCalled();
  });

  it("400s on a priority label that doesn't exist", async () => {
    const app = makeApp();
    const res = await postJson(app, "/api/tickets/alpha/7/priority", { priority: "urgent" });
    expect(res.status).toBe(400);
    expect(github.setPriority).not.toHaveBeenCalled();
  });
});
