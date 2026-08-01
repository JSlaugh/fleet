import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, ProjectConfig } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { ApprovalManager } from "./approvals.ts";
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

/** Wires a real `ApprovalManager` (not stubbed) so requesting/resolving approvals actually settles promises. */
function makeApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-approvals-"));
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
  const approvals = new ApprovalManager();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, approvals };
}

const post = (app: ReturnType<typeof makeApp>["app"], path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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

    const res = await post(app, `/api/approvals/${id}`, { decision: "allow" });

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

    const res = await post(app, `/api/approvals/${id}`, { decision: "deny" });

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

    const res = await post(app, `/api/approvals/${id}`, { decision: "answer", message: "use option A" });

    expect(res.status).toBe(200);
    // The route only sets `allowed: true` for `decision === "allow"` — an
    // "answer" carries its message but resolves `allowed: false`.
    await expect(outcome).resolves.toEqual({ allowed: false, message: "use option A" });
  });

  it("400s on an invalid decision", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/approvals/whatever", { decision: "maybe" });
    expect(res.status).toBe(400);
  });

  it("400s when answering without a message", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/approvals/whatever", { decision: "answer" });
    expect(res.status).toBe(400);
  });

  it("404s for an approval that doesn't exist (already settled or timed out)", async () => {
    const { app } = makeApp();
    const res = await post(app, "/api/approvals/nope", { decision: "allow" });
    expect(res.status).toBe(404);
  });
});
