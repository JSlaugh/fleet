import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, ProjectConfig, TicketDetail } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import { FleetLoop } from "../loop/loop.ts";
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
};

function makeApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-server-journal-"));
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
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, dataDir };
}

function writeJournal(dataDir: string, issueNumber: number, lines: string[]): void {
  const dir = join(dataDir, "journals", "alpha");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${issueNumber}.jsonl`), lines.join("\n"));
}

async function fetchJournal(app: ReturnType<typeof makeApp>["app"], issueNumber: number) {
  const res = await app.request(`/api/tickets/alpha/${issueNumber}`);
  const body = (await res.json()) as TicketDetail;
  return body.journal;
}

describe("readJournalTail (via GET /api/tickets/:project/:issue)", () => {
  it("returns an empty array when no journal file exists yet", async () => {
    const { app } = makeApp();
    expect(await fetchJournal(app, 1)).toEqual([]);
  });

  it("parses every line of a well-formed journal", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 2, [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "fleet", event: "started" }),
      JSON.stringify({ ts: "2026-01-01T00:01:00.000Z", type: "assistant", text: "on it" }),
    ]);

    const journal = await fetchJournal(app, 2);

    expect(journal).toEqual([
      { ts: "2026-01-01T00:00:00.000Z", type: "fleet", event: "started" },
      { ts: "2026-01-01T00:01:00.000Z", type: "assistant", text: "on it" },
    ]);
  });

  it("tolerates a corrupt line by falling back to an empty journal rather than throwing", async () => {
    // readJournalTail wraps the whole parse in one try/catch, so today a single
    // malformed line drops the entire tail — this pins that behavior rather
    // than crashing the request.
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 3, [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "fleet", event: "started" }),
      "{not valid json",
      JSON.stringify({ ts: "2026-01-01T00:02:00.000Z", type: "fleet", event: "finished" }),
    ]);

    const res = await app.request("/api/tickets/alpha/3");
    expect(res.status).toBe(200);
    expect(await fetchJournal(app, 3)).toEqual([]);
  });

  it("ignores a trailing blank line rather than treating it as corrupt", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 4, [JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "fleet", event: "started" }), ""]);

    expect(await fetchJournal(app, 4)).toEqual([{ ts: "2026-01-01T00:00:00.000Z", type: "fleet", event: "started" }]);
  });

  it("caps the tail at 200 entries, keeping the most recent", async () => {
    const { app, dataDir } = makeApp();
    const lines = Array.from({ length: 205 }, (_, i) => JSON.stringify({ ts: `entry-${i}`, type: "fleet" }));
    writeJournal(dataDir, 5, lines);

    const journal = await fetchJournal(app, 5);

    expect(journal).toHaveLength(200);
    expect(journal[0]).toEqual({ ts: "entry-5", type: "fleet" });
    expect(journal[journal.length - 1]).toEqual({ ts: "entry-204", type: "fleet" });
  });
});
