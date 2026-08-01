import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, ProjectConfig } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "./approvals.ts";
import { FleetLoop } from "./loop.ts";
import { createApp } from "./server.ts";
import { StateStore } from "./state.ts";

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

function makeApp(dashboardDist: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-static-"));
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
    projects: [project],
  };
  const approvals = { request: vi.fn(), list: vi.fn(() => []) } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  return createApp({ loop, state, approvals, dataDir, dashboardDist });
}

// Note: `startServer`'s WS upgrade handling and `board`/`approvals` broadcast
// fan-out aren't covered here — they only exist once `serve()` binds a real
// listening socket, which `createApp` (and `app.request()`) deliberately
// avoids. Exercising that would mean starting a real HTTP server and opening
// a real WebSocket client per test, which felt like the wrong tradeoff for
// what's a thin, easily-inspected pass-through (`loop.events`/`approvals.events`
// → `broadcast(type)` → every open `ws` client).

describe("static dashboard serving", () => {
  it("tells the operator to build the dashboard when dashboardDist doesn't exist", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-static-"));
    const app = makeApp(join(dataDir, "no-such-dist"));

    const res = await app.request("/some/dashboard/route");

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("pnpm --filter @fleet/dashboard build");
  });

  it("serves index.html for an unknown path once the dashboard is built", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-static-"));
    const dist = join(dataDir, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<html><body>fleet dashboard</body></html>");

    const app = makeApp(dist);
    const res = await app.request("/some/spa/route");

    expect(await res.text()).toContain("fleet dashboard");
  });

  it("serves a static asset directly", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-static-"));
    const dist = join(dataDir, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<html></html>");
    writeFileSync(join(dist, "app.js"), "console.log('hi')");

    const app = makeApp(dist);
    const res = await app.request("/app.js");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("console.log");
  });
});
