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
  setPriority: vi.fn(async () => {}),
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

function makeApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-priority-"));
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

beforeEach(() => {
  vi.clearAllMocks();
});

const post = (app: ReturnType<typeof makeApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/tickets/:project/:issue/priority", () => {
  it("sets the priority and returns ok", async () => {
    const app = makeApp();
    const res = await post(app, "/api/tickets/alpha/7/priority", { priority: "fleet:p1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(github.setPriority).toHaveBeenCalledWith(project, 7, "fleet:p1");
  });

  it("accepts null to clear the priority", async () => {
    const app = makeApp();
    const res = await post(app, "/api/tickets/alpha/7/priority", { priority: null });
    expect(res.status).toBe(200);
    expect(github.setPriority).toHaveBeenCalledWith(project, 7, null);
  });

  it("404s on an unknown project", async () => {
    const app = makeApp();
    const res = await post(app, "/api/tickets/nope/7/priority", { priority: "fleet:p1" });
    expect(res.status).toBe(404);
    expect(github.setPriority).not.toHaveBeenCalled();
  });

  it("404s on a non-numeric issue number", async () => {
    const app = makeApp();
    const res = await post(app, "/api/tickets/alpha/abc/priority", { priority: "fleet:p1" });
    expect(res.status).toBe(404);
  });

  it("400s on a priority label that doesn't exist", async () => {
    const app = makeApp();
    const res = await post(app, "/api/tickets/alpha/7/priority", { priority: "urgent" });
    expect(res.status).toBe(400);
    expect(github.setPriority).not.toHaveBeenCalled();
  });
});
