import { join } from "node:path";
import type { TicketDiff } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  getPrDiff: vi.fn(),
}));

const github = await import("../github/github.ts");

const project = makeProject();

function makeApp() {
  const { dataDir, state } = makeTempState("fleet-server-diff-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, state };
}

beforeEach(() => {
  vi.mocked(github.getPrDiff).mockReset();
});

describe("GET /api/tickets/:project/:issue/diff", () => {
  it("404s on an unknown project", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/tickets/nope/9/diff");
    expect(res.status).toBe(404);
  });

  it("404s on a non-numeric issue number", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/tickets/alpha/abc/diff");
    expect(res.status).toBe(404);
  });

  it("404s when the ticket has no PR yet", async () => {
    const { app, state } = makeApp();
    state.upsert(
      makeRecord({
        issueNumber: 9,
        issueTitle: "No PR yet",
        branch: "fleet/9",
        worktreePath: "/tmp/wt/9",
        status: "running",
      }),
    );
    const res = await app.request("/api/tickets/alpha/9/diff");
    expect(res.status).toBe(404);
    expect(vi.mocked(github.getPrDiff)).not.toHaveBeenCalled();
  });

  it("404s when the ticket is entirely unknown", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/tickets/alpha/999/diff");
    expect(res.status).toBe(404);
  });

  it("returns the diff and file list for a ticket with an open PR", async () => {
    const { app, state } = makeApp();
    state.upsert(
      makeRecord({
        issueNumber: 9,
        issueTitle: "In review",
        branch: "fleet/9",
        worktreePath: "/tmp/wt/9",
        status: "review",
        prUrl: "https://github.com/acme/alpha/pull/9",
      }),
    );
    vi.mocked(github.getPrDiff).mockResolvedValue({
      diff: "diff --git a/foo.ts b/foo.ts\n+added line\n-removed line",
      files: [{ path: "foo.ts", additions: 1, deletions: 1 }],
    });

    const res = await app.request("/api/tickets/alpha/9/diff");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TicketDiff;
    expect(body.prUrl).toBe("https://github.com/acme/alpha/pull/9");
    expect(body.files).toEqual([{ path: "foo.ts", additions: 1, deletions: 1 }]);
    expect(body.diff).toContain("added line");
    expect(body.truncated).toBe(false);
    expect(vi.mocked(github.getPrDiff)).toHaveBeenCalledWith(project, "https://github.com/acme/alpha/pull/9");
  });

  it("truncates an oversized diff and flags it", async () => {
    const { app, state } = makeApp();
    state.upsert(
      makeRecord({
        issueNumber: 9,
        issueTitle: "Huge diff",
        branch: "fleet/9",
        worktreePath: "/tmp/wt/9",
        status: "review",
        prUrl: "https://github.com/acme/alpha/pull/9",
      }),
    );
    const hugeDiff = "x".repeat(250_000);
    vi.mocked(github.getPrDiff).mockResolvedValue({ diff: hugeDiff, files: [] });

    const res = await app.request("/api/tickets/alpha/9/diff");
    const body = (await res.json()) as TicketDiff;
    expect(body.truncated).toBe(true);
    expect(body.diff.length).toBe(200_000);
  });

  it("502s when gh fails", async () => {
    const { app, state } = makeApp();
    state.upsert(
      makeRecord({
        issueNumber: 9,
        issueTitle: "In review",
        branch: "fleet/9",
        worktreePath: "/tmp/wt/9",
        status: "review",
        prUrl: "https://github.com/acme/alpha/pull/9",
      }),
    );
    vi.mocked(github.getPrDiff).mockRejectedValue(new Error("gh: rate limited"));

    const res = await app.request("/api/tickets/alpha/9/diff");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("rate limited");
  });
});
