import { join } from "node:path";
import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState, postJson } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

vi.mock("../github/github.ts", () => ({
  markReady: vi.fn(async () => {}),
  upsertStatusComment: vi.fn(async () => {}),
  clearAssignees: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

const project: ProjectConfig = makeProject();

/** This file's ticket is issue 7, defaulting to a failed run; keep a local wrapper over the shared factory. */
function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    status: "failed",
    costUsd: 3,
    ...patch,
  });
}

function makeApp(seed?: TicketRecord) {
  const { dataDir, state } = makeTempState("fleet-server-restart-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const internals = loop as unknown as { running: Map<string, Promise<void>> };
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, state, internals };
}

const post = (app: ReturnType<typeof makeApp>["app"], path: string) => app.request(path, { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/tickets/:project/:issue/restart", () => {
  it("resets a known ticket to fleet:ready", async () => {
    const { app, state } = makeApp(record());

    const res = await post(app, "/api/tickets/alpha/7/restart");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(github.markReady).toHaveBeenCalledWith(project, 7);
    expect(state.get("alpha", 7)?.status).toBe("restarting");
  });

  it("404s on an unknown project", async () => {
    const { app } = makeApp(record());
    const res = await post(app, "/api/tickets/nope/7/restart");
    expect(res.status).toBe(404);
    expect(github.markReady).not.toHaveBeenCalled();
  });

  it("404s on a ticket the daemon has never heard of", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/tickets/alpha/999/restart");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not a known fleet ticket/);
  });

  it("409s when the ticket is mid-transition (in flight, no live session to abort)", async () => {
    const { app, internals } = makeApp(record());
    internals.running.set("alpha#7", new Promise<void>(() => {}));

    const res = await post(app, "/api/tickets/alpha/7/restart");

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mid-transition/);
    expect(github.markReady).not.toHaveBeenCalled();
  });
});
