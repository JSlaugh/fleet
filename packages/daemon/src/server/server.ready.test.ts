import { join } from "node:path";
import type { BoardTicket } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  markReady: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

const project = makeProject();

function boardTicket(patch: Partial<BoardTicket> = {}): BoardTicket {
  return {
    project: "alpha",
    issueNumber: 41,
    title: "child 41",
    url: "https://github.com/acme/alpha/issues/41",
    status: "backlog",
    priority: null,
    type: null,
    isPlan: false,
    ...patch,
  };
}

function makeApp(tickets: BoardTicket[]) {
  const { dataDir, state } = makeTempState("fleet-server-ready-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  (loop as unknown as { boardCache: Map<string, BoardTicket[]> }).boardCache.set("alpha", tickets);
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app };
}

const post = (app: ReturnType<typeof makeApp>["app"], path: string) => app.request(path, { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/tickets/:project/:issue/ready", () => {
  it("releases a backlog ticket to fleet:ready", async () => {
    const { app } = makeApp([boardTicket()]);

    const res = await post(app, "/api/tickets/alpha/41/ready");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(github.markReady).toHaveBeenCalledWith(project, 41);
  });

  it("refuses a ticket that is not in the backlog column", async () => {
    const { app } = makeApp([boardTicket({ status: "in-progress" })]);

    const res = await post(app, "/api/tickets/alpha/41/ready");

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not in the backlog/);
    expect(github.markReady).not.toHaveBeenCalled();
  });

  it("404s on a ticket the board does not show", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/tickets/alpha/41/ready");
    expect(res.status).toBe(404);
    expect(github.markReady).not.toHaveBeenCalled();
  });

  it("404s on an unknown project", async () => {
    const { app } = makeApp([boardTicket()]);
    const res = await post(app, "/api/tickets/nope/41/ready");
    expect(res.status).toBe(404);
  });
});
