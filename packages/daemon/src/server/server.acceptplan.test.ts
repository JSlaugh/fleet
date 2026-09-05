import { join } from "node:path";
import type { TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  closeIssue: vi.fn(async () => {}),
  upsertStatusComment: vi.fn(async () => {}),
  getIssue: vi.fn(async () => ({
    number: 7,
    title: "epic 7",
    body: ["Epic body", "", "## Children", "- [ ] #41 add the field", "- [ ] #42 use the field", "- [x] #43 already done"].join("\n"),
    labels: ["fleet:review", "fleet:plan"],
  })),
  getIssueLabels: vi.fn(async () => ["fleet:backlog"]),
  markReady: vi.fn(async () => {}),
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
  // clearAllMocks keeps per-test mockImplementation overrides — reset the defaults explicitly.
  vi.mocked(github.getIssueLabels).mockResolvedValue(["fleet:backlog"]);
  vi.mocked(github.markReady).mockResolvedValue(undefined);
});

describe("POST /api/tickets/:project/:issue/accept-plan", () => {
  it("releases every open backlog child to fleet:ready, closes the epic, and reports both in the status comment", async () => {
    const { app } = makeApp(record());

    const res = await post(app, "/api/tickets/alpha/7/accept-plan");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, released: [41, 42], failed: [] });
    expect(github.markReady).toHaveBeenCalledTimes(2);
    expect(github.markReady).toHaveBeenCalledWith(project, 41);
    expect(github.markReady).toHaveBeenCalledWith(project, 42);
    expect(github.closeIssue).toHaveBeenCalledWith(project, 7);
    expect(github.upsertStatusComment).toHaveBeenCalledWith(project, 7, expect.stringContaining("Plan accepted by operator."));
    expect(github.upsertStatusComment).toHaveBeenCalledWith(project, 7, expect.stringContaining("Released to `fleet:ready`: #41, #42"));
  });

  it("leaves a child alone when a human already moved it past the backlog", async () => {
    vi.mocked(github.getIssueLabels).mockImplementation(async (_p, n) => (n === 41 ? ["fleet:in-progress"] : ["fleet:backlog"]));
    const { app } = makeApp(record());

    const res = await post(app, "/api/tickets/alpha/7/accept-plan");

    expect(await res.json()).toEqual({ ok: true, released: [42], failed: [] });
    expect(github.markReady).not.toHaveBeenCalledWith(project, 41);
    expect(github.closeIssue).toHaveBeenCalledWith(project, 7);
  });

  it("still closes the epic when a child fails to relabel, naming it for manual follow-up", async () => {
    vi.mocked(github.markReady).mockImplementation(async (_p, n) => {
      if (n === 42) throw new Error("gh exploded");
    });
    const { app } = makeApp(record());

    const res = await post(app, "/api/tickets/alpha/7/accept-plan");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, released: [41], failed: [42] });
    expect(github.closeIssue).toHaveBeenCalledWith(project, 7);
    expect(github.upsertStatusComment).toHaveBeenCalledWith(project, 7, expect.stringContaining("Could not relabel (mark `fleet:ready` by hand): #42"));
  });

  it("closes an epic with no children stamped on its body without touching any labels", async () => {
    vi.mocked(github.getIssue).mockResolvedValue({ number: 7, title: "epic 7", body: "no children here", labels: [] });
    const { app } = makeApp(record());

    const res = await post(app, "/api/tickets/alpha/7/accept-plan");

    expect(await res.json()).toEqual({ ok: true, released: [], failed: [] });
    expect(github.markReady).not.toHaveBeenCalled();
    expect(github.closeIssue).toHaveBeenCalledWith(project, 7);
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
