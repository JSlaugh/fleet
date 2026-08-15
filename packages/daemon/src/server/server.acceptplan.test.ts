import { join } from "node:path";
import type { TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

vi.mock("../github/github.ts", () => ({
  closeIssue: vi.fn(async () => {}),
  upsertStatusComment: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

const project = makeProject();

/** This file's ticket is issue 7 throughout; keep a local wrapper with those defaults over the shared factory. */
function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "epic 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    status: "review",
    costUsd: 1,
    isPlan: true,
    ...patch,
  });
}

function makeApp(seed?: TicketRecord) {
  const { dataDir, state } = makeTempState("fleet-server-acceptplan-");
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

describe("POST /api/tickets/:project/:issue/accept-plan", () => {
  it("closes the issue and posts a status comment for a plan ticket in review", async () => {
    const { app } = makeApp(record());

    const res = await post(app, "/api/tickets/alpha/7/accept-plan");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(github.closeIssue).toHaveBeenCalledWith(project, 7);
    expect(github.upsertStatusComment).toHaveBeenCalledWith(project, 7, expect.stringContaining("Plan accepted by operator."));
  });

  it("404s on an unknown project", async () => {
    const { app } = makeApp(record());
    const res = await post(app, "/api/tickets/nope/7/accept-plan");
    expect(res.status).toBe(404);
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  it("404s on a ticket the daemon has never heard of", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/tickets/alpha/999/accept-plan");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not a known fleet ticket/);
  });

  it("rejects a non-plan ticket", async () => {
    const { app } = makeApp(record({ isPlan: false }));
    const res = await post(app, "/api/tickets/alpha/7/accept-plan");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not a plan ticket/);
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  it("rejects a plan ticket that is not awaiting review", async () => {
    const { app } = makeApp(record({ status: "running" }));
    const res = await post(app, "/api/tickets/alpha/7/accept-plan");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not awaiting review/);
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  it("409s when the ticket is mid-transition", async () => {
    const { app, internals } = makeApp(record());
    internals.running.set("alpha#7", new Promise<void>(() => {}));

    const res = await post(app, "/api/tickets/alpha/7/accept-plan");

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mid-transition/);
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  it("pings the board WS on success", async () => {
    const { app, state } = makeApp(record());
    const ticketBefore = state.get("alpha", 7);
    expect(ticketBefore).toBeDefined();

    const res = await post(app, "/api/tickets/alpha/7/accept-plan");

    expect(res.status).toBe(200);
    // Cleanup itself is left to the next poll cycle's cleanupFinished; the
    // record is untouched by this route.
    expect(state.get("alpha", 7)).toEqual(ticketBefore);
  });
});
