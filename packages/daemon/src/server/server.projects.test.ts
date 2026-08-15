import { join } from "node:path";
import type { ProjectConfig } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState, postJson } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

vi.mock("../github/github.ts", () => ({
  createIssue: vi.fn(async () => ({ number: 42, url: "https://github.com/acme/alpha/issues/42" })),
}));

const github = await import("../github/github.ts");

const project: ProjectConfig = makeProject();

function makeApp() {
  const { dataDir, state } = makeTempState("fleet-server-projects-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  return createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/projects/:project/tickets", () => {
  it("files a ready ticket with a priority label", async () => {
    const app = makeApp();
    const res = await postJson(app, "/api/projects/alpha/tickets", { title: "Add a thing", body: "details", priority: "fleet:p2" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: 42, url: "https://github.com/acme/alpha/issues/42" });
    expect(github.createIssue).toHaveBeenCalledWith(project, {
      title: "Add a thing",
      body: "details",
      labels: ["fleet:ready", "fleet:p2"],
    });
  });

  it("appends a Depends-on line when dependsOn is given", async () => {
    const app = makeApp();
    await postJson(app, "/api/projects/alpha/tickets", { title: "t", body: "b", dependsOn: [12] });
    expect(github.createIssue).toHaveBeenCalledWith(project, {
      title: "t",
      body: "b\n\nDepends-on: #12",
      labels: ["fleet:ready"],
    });
  });

  it("404s on an unknown project", async () => {
    const app = makeApp();
    const res = await postJson(app, "/api/projects/nope/tickets", { title: "t", body: "b" });
    expect(res.status).toBe(404);
    expect(github.createIssue).not.toHaveBeenCalled();
  });

  it("400s on an invalid body", async () => {
    const app = makeApp();
    const res = await postJson(app, "/api/projects/alpha/tickets", { title: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown };
    expect(body.error).toBe("invalid request body");
    expect(body.issues).toBeDefined();
    expect(github.createIssue).not.toHaveBeenCalled();
  });

  it("400s on a non-JSON body", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/alpha/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("502s when GitHub issue creation fails", async () => {
    vi.mocked(github.createIssue).mockRejectedValueOnce(new Error("gh: rate limited"));
    const app = makeApp();
    const res = await postJson(app, "/api/projects/alpha/tickets", { title: "t", body: "b" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("gh: rate limited");
  });
});

describe("GET /api/projects/:project/backlog", () => {
  it("returns an empty ticket list when the board cache is empty", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/alpha/backlog");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tickets: [] });
  });

  it("404s on an unknown project", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/nope/backlog");
    expect(res.status).toBe(404);
  });
});
