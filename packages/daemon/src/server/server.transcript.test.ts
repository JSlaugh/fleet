import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TicketTranscript } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { createApp } from "./server.ts";

const project = makeProject();

function makeApp() {
  const { dataDir, state } = makeTempState("fleet-server-transcript-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, dataDir };
}

function seedTranscript(dataDir: string, issueNumber: number, files: Record<string, string>): void {
  const dir = join(dataDir, "transcripts", "alpha", String(issueNumber));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

describe("GET /api/tickets/:project/:issue/transcript", () => {
  it("404s when nothing has been archived for the ticket yet", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/tickets/alpha/9/transcript");
    expect(res.status).toBe(404);
  });

  it("404s on an unknown project", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/tickets/nope/9/transcript");
    expect(res.status).toBe(404);
  });

  it("returns the archived transcript content for a ticket with one session file", async () => {
    const { app, dataDir } = makeApp();
    seedTranscript(dataDir, 9, { "sess-1.jsonl": '{"type":"user"}\n' });

    const res = await app.request("/api/tickets/alpha/9/transcript");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TicketTranscript;
    expect(body.files).toEqual([{ name: "sess-1.jsonl", content: '{"type":"user"}\n' }]);
  });

  it("returns every archived session file for a ticket that ran through multiple sessions", async () => {
    const { app, dataDir } = makeApp();
    seedTranscript(dataDir, 9, {
      "sess-1.jsonl": "first\n",
      "sess-2.jsonl": "second\n",
    });

    const res = await app.request("/api/tickets/alpha/9/transcript");
    const body = (await res.json()) as TicketTranscript;
    expect(body.files.map((f) => f.name).sort()).toEqual(["sess-1.jsonl", "sess-2.jsonl"]);
  });

  it("ignores non-.jsonl files alongside the archived transcripts", async () => {
    const { app, dataDir } = makeApp();
    seedTranscript(dataDir, 9, {
      "sess-1.jsonl": "session\n",
      ".DS_Store": "junk",
    });

    const res = await app.request("/api/tickets/alpha/9/transcript");
    const body = (await res.json()) as TicketTranscript;
    expect(body.files.map((f) => f.name)).toEqual(["sess-1.jsonl"]);
  });
});
