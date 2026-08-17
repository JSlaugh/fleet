import { join } from "node:path";
import type { JournalEntry, TicketDetail } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeTempState } from "../test-support.ts";
import { FleetLoop } from "../loop/loop.ts";
import { insertJournalEntry, openDatabase } from "../store/db.ts";
import { createApp } from "./server.ts";

const project = makeProject();

function makeApp() {
  const { dataDir, state } = makeTempState("fleet-server-journal-");
  const config = makeFleetConfig({ dataDir, projects: [project] });
  const approvals = makeApprovals();
  const loop = new FleetLoop(config, state, dataDir, approvals, false);
  const app = createApp({ loop, state, approvals, dataDir, dashboardDist: join(dataDir, "no-dashboard-build") });
  return { app, dataDir };
}

/** Inserts rows straight into `journal_entries`, bypassing `Journal.append`'s `v`/`ts` defaulting, so tests can assert exact entry shapes. */
function writeJournal(dataDir: string, issueNumber: number, entries: JournalEntry[]): void {
  const db = openDatabase(dataDir);
  for (const entry of entries) insertJournalEntry(db, "alpha", issueNumber, entry);
}

async function fetchJournal(app: ReturnType<typeof makeApp>["app"], issueNumber: number) {
  const res = await app.request(`/api/tickets/alpha/${issueNumber}`);
  const body = (await res.json()) as TicketDetail;
  return body.journal;
}

describe("readJournalTail (via GET /api/tickets/:project/:issue)", () => {
  it("returns an empty array when no entries exist yet", async () => {
    const { app } = makeApp();
    expect(await fetchJournal(app, 1)).toEqual([]);
  });

  it("returns every entry for the ticket, oldest first", async () => {
    const { app, dataDir } = makeApp();
    writeJournal(dataDir, 2, [
      { ts: "2026-01-01T00:00:00.000Z", type: "fleet", event: "started" },
      { ts: "2026-01-01T00:01:00.000Z", type: "assistant", text: "on it" },
    ]);

    const journal = await fetchJournal(app, 2);

    expect(journal).toEqual([
      { ts: "2026-01-01T00:00:00.000Z", type: "fleet", event: "started" },
      { ts: "2026-01-01T00:01:00.000Z", type: "assistant", text: "on it" },
    ]);
  });

  it("caps the tail at 200 entries, keeping the most recent", async () => {
    const { app, dataDir } = makeApp();
    const entries: JournalEntry[] = Array.from({ length: 205 }, (_, i) => ({ ts: `entry-${i}`, type: "fleet" }));
    writeJournal(dataDir, 5, entries);

    const journal = await fetchJournal(app, 5);

    expect(journal).toHaveLength(200);
    expect(journal[0]).toEqual({ ts: "entry-5", type: "fleet" });
    expect(journal[journal.length - 1]).toEqual({ ts: "entry-204", type: "fleet" });
  });
});
