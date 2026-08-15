import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeFleetConfig, makeProject, makeTempState, postJson } from "../test-support.ts";
import { ApprovalManager } from "../session/approvals.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

const project = makeProject();

/** Wires a real `ApprovalManager` (not stubbed) so requesting/resolving approvals actually settles promises. */
function makeApp() {
  const { dataDir, state } = makeTempState("fleet-server-approvals-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = new ApprovalManager();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, approvals };
}

describe("GET /api/approvals", () => {
  it("lists nothing when there are no pending approvals", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/approvals");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvals: [] });
  });

  it("lists a pending approval request", async () => {
    const { app, approvals } = makeApp();
    void approvals.request({
      project: "alpha",
      issueNumber: 7,
      toolName: "Bash",
      kind: "permission",
      input: { command: "rm -rf /" },
      timeoutMs: 60_000,
    });

    const res = await app.request("/api/approvals");
    const body = (await res.json()) as { approvals: { toolName: string; issueNumber: number }[] };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]).toMatchObject({ toolName: "Bash", issueNumber: 7 });
  });
});

describe("POST /api/approvals/:id", () => {
  it("allows a pending approval", async () => {
    const { app, approvals } = makeApp();
    const outcome = approvals.request({
      project: "alpha",
      issueNumber: 7,
      toolName: "Bash",
      kind: "permission",
      input: {},
      timeoutMs: 60_000,
    });
    const id = approvals.list()[0]?.id;

    const res = await postJson(app, `/api/approvals/${id}`, { decision: "allow" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await expect(outcome).resolves.toEqual({ allowed: true, message: undefined });
  });

  it("denies a pending approval", async () => {
    const { app, approvals } = makeApp();
    const outcome = approvals.request({
      project: "alpha",
      issueNumber: 7,
      toolName: "Bash",
      kind: "permission",
      input: {},
      timeoutMs: 60_000,
    });
    const id = approvals.list()[0]?.id;

    const res = await postJson(app, `/api/approvals/${id}`, { decision: "deny" });

    expect(res.status).toBe(200);
    await expect(outcome).resolves.toEqual({ allowed: false, message: undefined });
  });

  it("answers a pending question with a message", async () => {
    const { app, approvals } = makeApp();
    const outcome = approvals.request({
      project: "alpha",
      issueNumber: 7,
      toolName: "AskUserQuestion",
      kind: "question",
      input: {},
      timeoutMs: 60_000,
    });
    const id = approvals.list()[0]?.id;

    const res = await postJson(app, `/api/approvals/${id}`, { decision: "answer", message: "use option A" });

    expect(res.status).toBe(200);
    // The route only sets `allowed: true` for `decision === "allow"` — an
    // "answer" carries its message but resolves `allowed: false`.
    await expect(outcome).resolves.toEqual({ allowed: false, message: "use option A" });
  });

  it("400s on an invalid decision", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/api/approvals/whatever", { decision: "maybe" });
    expect(res.status).toBe(400);
  });

  it("400s when answering without a message", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/api/approvals/whatever", { decision: "answer" });
    expect(res.status).toBe(400);
  });

  it("404s for an approval that doesn't exist (already settled or timed out)", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/api/approvals/nope", { decision: "allow" });
    expect(res.status).toBe(404);
  });
});
