import { join } from "node:path";
import type { ProjectConfig } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState, postJson } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

const project: ProjectConfig = makeProject();

function makeApp() {
  const { dataDir, state } = makeTempState("fleet-server-shutdown-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const exit = vi.fn();
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build"), exit });
  const internals = loop as unknown as {
    live: Map<string, { abortController: AbortController; sessionId?: string }>;
    running: Map<string, Promise<void>>;
  };
  return { app, state, loop, exit, internals };
}

describe("POST /api/daemon/shutdown", () => {
  it("rejects a mode that isn't drain or now", async () => {
    const { app, exit } = makeApp();
    const res = await postJson(app, "/api/daemon/shutdown", { mode: "later" });
    expect(res.status).toBe(400);
    expect(exit).not.toHaveBeenCalled();
  });

  it("drain mode pauses immediately and exits once nothing is running", async () => {
    const { app, state, exit } = makeApp();

    const res = await postJson(app, "/api/daemon/shutdown", { mode: "drain" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "drain" });
    expect(state.getPaused()).toBe(true);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("now mode aborts live sessions and exits once they settle", async () => {
    const { app, exit, internals } = makeApp();
    const abortController = new AbortController();
    internals.live.set("alpha#7", { abortController, sessionId: "sess-7" });
    let resolveRun: (() => void) | undefined;
    internals.running.set(
      "alpha#7",
      new Promise<void>((resolve) => {
        abortController.signal.addEventListener("abort", () => resolve());
        resolveRun = resolve;
      }),
    );

    const res = await postJson(app, "/api/daemon/shutdown", { mode: "now" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "now" });
    expect(abortController.signal.aborted).toBe(true);

    resolveRun?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("409s a second shutdown request while one is already in progress", async () => {
    const { app, internals, exit } = makeApp();
    internals.running.set("alpha#7", new Promise<void>(() => {}));

    const first = await postJson(app, "/api/daemon/shutdown", { mode: "drain" });
    expect(first.status).toBe(200);

    const second = await postJson(app, "/api/daemon/shutdown", { mode: "now" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/already in progress/);
    expect(exit).not.toHaveBeenCalled();
  });
});
