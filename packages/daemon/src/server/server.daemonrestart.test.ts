import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, ProjectConfig } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import { FleetLoop } from "../loop/loop.ts";
import { RESTART_EXIT_CODE } from "../restart-code.ts";
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
  autoMerge: false,
  mergeMethod: "squash",
};

function makeApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-daemonrestart-"));
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
  const exit = vi.fn();
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build"), exit });
  const internals = loop as unknown as {
    live: Map<string, { abortController: AbortController; sessionId?: string }>;
    running: Map<string, Promise<void>>;
  };
  return { app, state, loop, exit, internals };
}

const post = (app: ReturnType<typeof makeApp>["app"], body?: unknown) =>
  app.request("/api/daemon/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("POST /api/daemon/restart", () => {
  it("rejects a mode that isn't drain or now", async () => {
    const { app, exit } = makeApp();
    const res = await post(app, { mode: "later" });
    expect(res.status).toBe(400);
    expect(exit).not.toHaveBeenCalled();
  });

  it("defaults to now mode when no body is sent", async () => {
    const { app, exit, internals } = makeApp();
    const abortController = new AbortController();
    internals.live.set("alpha#7", { abortController, sessionId: "sess-7" });
    internals.running.set(
      "alpha#7",
      new Promise<void>((resolve) => {
        abortController.signal.addEventListener("abort", () => resolve());
      }),
    );

    const res = await post(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "now" });
    expect(abortController.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE));
  });

  it("now mode aborts live sessions and exits RESTART_EXIT_CODE once they settle", async () => {
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

    const res = await post(app, { mode: "now" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "now" });
    expect(abortController.signal.aborted).toBe(true);

    resolveRun?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE));
  });

  it("drain mode pauses immediately and exits RESTART_EXIT_CODE once nothing is running", async () => {
    const { app, state, exit } = makeApp();

    const res = await post(app, { mode: "drain" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "drain" });
    expect(state.getPaused()).toBe(true);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE));
  });

  it("409s a restart racing an in-flight shutdown", async () => {
    const { app, loop, exit } = makeApp();
    expect(loop.beginShutdown()).toBe(true);

    const res = await post(app, { mode: "now" });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already in progress/);
    expect(exit).not.toHaveBeenCalled();
  });

  it("409s a second restart request while one is already in progress", async () => {
    const { app, internals, exit } = makeApp();
    internals.running.set("alpha#7", new Promise<void>(() => {}));

    const first = await post(app, { mode: "drain" });
    expect(first.status).toBe(200);

    const second = await post(app, { mode: "now" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/already in progress/);
    expect(exit).not.toHaveBeenCalled();
  });
});
