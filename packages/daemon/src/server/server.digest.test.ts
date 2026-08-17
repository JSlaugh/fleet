import { join } from "node:path";
import type { DigestResponse } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

const project = makeProject();

function makeApp() {
  const { dataDir, state } = makeTempState("fleet-server-digest-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  return { app: createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") }), state };
}

describe("GET /api/digest", () => {
  it("defaults to a 24h window and reflects live ticket state", async () => {
    const { app, state } = makeApp();
    state.upsert(makeRecord({ status: "review", lastActivityAt: new Date().toISOString() }));

    const res = await app.request("/api/digest");
    const body = (await res.json()) as DigestResponse;

    expect(res.status).toBe(200);
    expect(body.windowHours).toBe(24);
    expect(body.projects[0]?.completed).toHaveLength(1);
  });

  it("honors the hours query param", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/digest?hours=1");
    const body = (await res.json()) as DigestResponse;
    expect(body.windowHours).toBe(1);
  });

  it("400s on a non-positive hours", async () => {
    const { app } = makeApp();
    expect((await app.request("/api/digest?hours=0")).status).toBe(400);
    expect((await app.request("/api/digest?hours=-1")).status).toBe(400);
    expect((await app.request("/api/digest?hours=nope")).status).toBe(400);
  });

  it("returns an empty digest with no config/state at all", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/digest");
    const body = (await res.json()) as DigestResponse;
    expect(res.status).toBe(200);
    expect(body.projects).toEqual([]);
    expect(body.gateHolds).toEqual([]);
    expect(body.budget).toBeUndefined();
  });
});
