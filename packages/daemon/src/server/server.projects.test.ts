import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, ProjectConfig } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";
import { StateStore } from "../store/state.ts";

vi.mock("../github/github.ts", () => ({
  createIssue: vi.fn(async () => ({ number: 42, url: "https://github.com/acme/alpha/issues/42" })),
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
  autoMerge: false,
  mergeMethod: "squash",
};

function makeApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-projects-"));
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
    projects: [project],
  };
  const approvals = { request: vi.fn(), list: vi.fn(() => []) } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  return createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
}

const post = (app: ReturnType<typeof makeApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/projects/:project/tickets", () => {
  it("files a ready ticket with a priority label", async () => {
    const app = makeApp();
    const res = await post(app, "/api/projects/alpha/tickets", { title: "Add a thing", body: "details", priority: "fleet:p2" });

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
    await post(app, "/api/projects/alpha/tickets", { title: "t", body: "b", dependsOn: [12] });
    expect(github.createIssue).toHaveBeenCalledWith(project, {
      title: "t",
      body: "b\n\nDepends-on: #12",
      labels: ["fleet:ready"],
    });
  });

  it("404s on an unknown project", async () => {
    const app = makeApp();
    const res = await post(app, "/api/projects/nope/tickets", { title: "t", body: "b" });
    expect(res.status).toBe(404);
    expect(github.createIssue).not.toHaveBeenCalled();
  });

  it("400s on an invalid body", async () => {
    const app = makeApp();
    const res = await post(app, "/api/projects/alpha/tickets", { title: "" });
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
    const res = await post(app, "/api/projects/alpha/tickets", { title: "t", body: "b" });
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
