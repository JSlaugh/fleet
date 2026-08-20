import { join } from "node:path";
import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState, postJson } from "../test-support.ts";
import { readJournalTail } from "../store/journal.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

vi.mock("../loop/runner.ts", () => ({
  resumeTicket: vi.fn(async () => {}),
}));

const runnerMod = await import("../loop/runner.ts");

const project: ProjectConfig = makeProject();

/** This file's ticket is issue 7 throughout; keep a local wrapper with those defaults over the shared factory. */
function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    costUsd: 3,
    ...patch,
  });
}

/** A `FleetLoop` over a throwaway data dir, plus handles on its private maps for seeding live/waiting sessions. */
function makeApp(seed?: TicketRecord) {
  const { dataDir, state } = makeTempState("fleet-server-reply-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const internals = loop as unknown as {
    live: Map<string, { send: (message: string) => void }>;
    replyWaiters: Map<string, (message: string | undefined) => void>;
  };
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, internals, dataDir };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/tickets/:project/:issue/reply", () => {
  it("400s on a missing message", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/api/tickets/alpha/7/reply", {});
    expect(res.status).toBe(400);
  });

  it("400s (not 500) on an empty body", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/tickets/alpha/7/reply", { method: "POST" });

    expect(res.status).toBe(400);
  });

  it("400s on a blank message", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/api/tickets/alpha/7/reply", { message: "   " });
    expect(res.status).toBe(400);
  });

  it("steers a session parked awaiting a reply", async () => {
    const { app, internals, dataDir } = makeApp(record({ status: "needs-input" }));
    const received: (string | undefined)[] = [];
    internals.replyWaiters.set("alpha#7", (message) => received.push(message));

    const res = await postJson(app, "/api/tickets/alpha/7/reply", { message: "keep going" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "steered" });
    expect(received).toEqual(["keep going"]);
    const entries = readJournalTail(dataDir, "alpha", 7, 10);
    expect(entries).toContainEqual(
      expect.objectContaining({ type: "fleet", event: "operator-message-injected", mode: "parked", reason: "operator-reply" }),
    );
  });

  it("steers a message into an already-live session", async () => {
    const { app, internals, dataDir } = makeApp(record());
    const send = vi.fn();
    internals.live.set("alpha#7", { send });

    const res = await postJson(app, "/api/tickets/alpha/7/reply", { message: "hello" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "steered" });
    expect(send).toHaveBeenCalledWith("hello");
    const entries = readJournalTail(dataDir, "alpha", 7, 10);
    expect(entries).toContainEqual(
      expect.objectContaining({ type: "fleet", event: "operator-message-injected", mode: "live", reason: "operator-reply" }),
    );
  });

  it("resumes a cold ticket with a recorded session id", async () => {
    const { app } = makeApp(record({ status: "needs-input", sessionId: "sess-7" }));

    const res = await postJson(app, "/api/tickets/alpha/7/reply", { message: "resume please" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "resumed" });
    expect(runnerMod.resumeTicket).toHaveBeenCalledWith(
      expect.anything(),
      project,
      expect.objectContaining({ issueNumber: 7 }),
      "resume please",
      "operator-reply",
    );
  });

  it("409s when no session is recorded for the ticket", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/api/tickets/alpha/7/reply", { message: "hello?" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no session recorded/);
  });

  it("409s for an unknown project (this route has no 404 path — it relies on loop.reply throwing)", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/api/tickets/nope/7/reply", { message: "hello?" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown project/);
  });
});
