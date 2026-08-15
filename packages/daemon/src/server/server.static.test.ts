import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

const project: ProjectConfig = makeProject();

function makeApp(dashboardDist: string) {
  const { dataDir, state } = makeTempState("fleet-server-static-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
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
