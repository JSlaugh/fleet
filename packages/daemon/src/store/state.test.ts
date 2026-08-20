import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClosedTicketRecord, TicketRecord } from "@fleet/shared";
import { afterEach, describe, expect, it } from "vitest";
import { makeRecord } from "../test-support.ts";
import { closeAllDatabases } from "./db.ts";
import { HistoryStore, StateStore } from "./state.ts";

function closed(issueNumber: number, closedAt: string, patch: Partial<ClosedTicketRecord> = {}): ClosedTicketRecord {
  const record = makeRecord({
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    branch: `fleet/${issueNumber}`,
    worktreePath: `/tmp/wt/${issueNumber}`,
    status: "review",
    costUsd: 1,
  });
  return { ...record, closedAt, prState: "MERGED", ...patch };
}

function ticket(issueNumber: number, patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    branch: `fleet/${issueNumber}`,
    worktreePath: `/tmp/wt/${issueNumber}`,
    costUsd: 1,
    ...patch,
  });
}

const dataDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-"));
  dataDirs.push(dir);
  return dir;
}

afterEach(() => {
  // An open sqlite handle blocks directory deletion on Windows, so close every
  // cached connection before rm'ing the temp dirs those connections live in.
  closeAllDatabases();
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migration from JSON", () => {
  it("creates an empty db when no state.json/history.json exist", () => {
    const dataDir = tempDataDir();
    const state = new StateStore(dataDir);
    const history = new HistoryStore(dataDir);
    expect(state.all()).toEqual([]);
    expect(history.all()).toEqual([]);
    expect(existsSync(join(dataDir, "fleet.db"))).toBe(true);
  });

  it("imports tickets, pause state, and the spend ledger from an existing state.json, then archives it", () => {
    const dataDir = tempDataDir();
    writeFileSync(
      join(dataDir, "state.json"),
      JSON.stringify({
        tickets: [ticket(1), ticket(2)],
        paused: true,
        pausedUntil: "2026-02-01T00:00:00.000Z",
        pausedProjects: ["alpha"],
        spendLedger: [{ at: new Date().toISOString(), usd: 4 }],
      }),
    );

    const state = new StateStore(dataDir);

    expect(state.all()).toHaveLength(2);
    expect(state.get("alpha", 1)?.issueNumber).toBe(1);
    expect(state.getPaused()).toBe(true);
    expect(state.getPausedUntil()).toBe("2026-02-01T00:00:00.000Z");
    expect(state.getPausedProjects()).toEqual(["alpha"]);
    expect(state.getWindowSpend(5)).toBe(4);
    expect(existsSync(join(dataDir, "state.json"))).toBe(false);
    expect(existsSync(join(dataDir, "state.json.imported.bak"))).toBe(true);
  });

  it("imports history records from an existing history.json, then archives it", () => {
    const dataDir = tempDataDir();
    writeFileSync(
      join(dataDir, "history.json"),
      JSON.stringify([closed(1, "2026-01-01T00:00:00.000Z"), closed(2, "2026-01-02T00:00:00.000Z")]),
    );

    const history = new HistoryStore(dataDir);

    expect(history.all().map((r) => r.issueNumber)).toEqual([2, 1]);
    expect(existsSync(join(dataDir, "history.json"))).toBe(false);
    expect(existsSync(join(dataDir, "history.json.imported.bak"))).toBe(true);
  });

  it("tolerates a corrupt state.json — starts empty and archives it as failed", () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "state.json"), "{not valid json");

    const state = new StateStore(dataDir);

    expect(state.all()).toEqual([]);
    expect(existsSync(join(dataDir, "state.json.failed.bak"))).toBe(true);
  });

  it("tolerates a corrupt history.json — starts empty and archives it as failed", () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "history.json"), "not json at all");

    const history = new HistoryStore(dataDir);

    expect(history.all()).toEqual([]);
    expect(existsSync(join(dataDir, "history.json.failed.bak"))).toBe(true);
  });

  it("does not import a state.json that appears after the first boot — the meta-key latch holds", () => {
    const dataDir = tempDataDir();
    new StateStore(dataDir);
    closeAllDatabases();
    writeFileSync(join(dataDir, "state.json"), JSON.stringify({ tickets: [ticket(1)] }));

    const reopened = new StateStore(dataDir);

    expect(reopened.all()).toEqual([]);
    // Latched out, archived unimported (indistinguishable from a lost rename).
    expect(existsSync(join(dataDir, "state.json"))).toBe(false);
    expect(existsSync(join(dataDir, "state.json.imported.bak"))).toBe(true);
  });

  it("does not double-import on a second boot even when the archival rename never happened", () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "history.json"), JSON.stringify([closed(1, "2026-01-01T00:00:00.000Z")]));
    const first = new HistoryStore(dataDir);
    expect(first.all()).toHaveLength(1);
    closeAllDatabases();
    // Simulate a crash-after-commit-before-rename: put the legacy file back.
    writeFileSync(join(dataDir, "history.json"), JSON.stringify([closed(1, "2026-01-01T00:00:00.000Z")]));

    const second = new HistoryStore(dataDir);

    expect(second.all()).toHaveLength(1);
  });

  it("strips a leading BOM before importing state.json", () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "state.json"), "﻿" + JSON.stringify({ tickets: [ticket(1)] }));

    const state = new StateStore(dataDir);

    expect(state.get("alpha", 1)?.issueNumber).toBe(1);
  });

  it("is idempotent — a second boot against the same data dir does not touch already-archived files or duplicate data", () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "state.json"), JSON.stringify({ tickets: [ticket(1)] }));

    new StateStore(dataDir);
    closeAllDatabases(); // simulate a process restart: force a real reopen from disk, not the connection cache

    const reopened = new StateStore(dataDir);
    expect(reopened.all()).toHaveLength(1);
    expect(existsSync(join(dataDir, "state.json"))).toBe(false);
    expect(existsSync(join(dataDir, "state.json.imported.bak"))).toBe(true);
  });
});

describe("StateStore", () => {
  it("starts empty in a freshly created data dir", () => {
    const dataDir = join(tempDataDir(), "nested");
    const store = new StateStore(dataDir);
    expect(store.all()).toEqual([]);
  });

  it("upsert inserts new records and overwrites existing ones by project+issueNumber", () => {
    const store = new StateStore(tempDataDir());
    store.upsert(ticket(1, { status: "running" }));
    store.upsert(ticket(1, { status: "review" }));
    expect(store.all()).toHaveLength(1);
    expect(store.get("alpha", 1)?.status).toBe("review");
  });

  it("persists across instances reading the same data dir", () => {
    const dataDir = tempDataDir();
    new StateStore(dataDir).upsert(ticket(1));
    const reopened = new StateStore(dataDir);
    expect(reopened.get("alpha", 1)?.issueNumber).toBe(1);
  });

  it("update patches an existing record and returns it", () => {
    const store = new StateStore(tempDataDir());
    store.upsert(ticket(1, { costUsd: 1 }));
    const updated = store.update("alpha", 1, { costUsd: 5 });
    expect(updated?.costUsd).toBe(5);
    expect(store.get("alpha", 1)?.costUsd).toBe(5);
  });

  it("update is a no-op returning undefined when the record does not exist", () => {
    const store = new StateStore(tempDataDir());
    const result = store.update("alpha", 999, { costUsd: 5 });
    expect(result).toBeUndefined();
    expect(store.all()).toEqual([]);
  });

  it("remove deletes the record and is a no-op if it is not present", () => {
    const store = new StateStore(tempDataDir());
    store.upsert(ticket(1));
    store.remove("alpha", 1);
    expect(store.get("alpha", 1)).toBeUndefined();
    expect(() => store.remove("alpha", 1)).not.toThrow();
  });

  it("getPausedUntil/setPausedUntil round-trip and persist", () => {
    const dataDir = tempDataDir();
    const store = new StateStore(dataDir);
    expect(store.getPausedUntil()).toBeUndefined();
    store.setPausedUntil("2026-02-01T00:00:00.000Z");
    expect(store.getPausedUntil()).toBe("2026-02-01T00:00:00.000Z");
    expect(new StateStore(dataDir).getPausedUntil()).toBe("2026-02-01T00:00:00.000Z");
    store.setPausedUntil(undefined);
    expect(store.getPausedUntil()).toBeUndefined();
  });

  it("getPaused/setPaused round-trip, default to false, and persist across instances", () => {
    const dataDir = tempDataDir();
    const store = new StateStore(dataDir);
    expect(store.getPaused()).toBe(false);
    store.setPaused(true);
    expect(store.getPaused()).toBe(true);
    expect(new StateStore(dataDir).getPaused()).toBe(true);
    store.setPaused(false);
    expect(new StateStore(dataDir).getPaused()).toBe(false);
  });

  describe("per-project pause", () => {
    it("defaults to unpaused, and setProjectPaused/isProjectPaused/getPausedProjects round-trip and persist", () => {
      const dataDir = tempDataDir();
      const store = new StateStore(dataDir);
      expect(store.isProjectPaused("alpha")).toBe(false);
      expect(store.getPausedProjects()).toEqual([]);

      store.setProjectPaused("alpha", true);
      expect(store.isProjectPaused("alpha")).toBe(true);
      expect(store.isProjectPaused("beta")).toBe(false);
      expect(store.getPausedProjects()).toEqual(["alpha"]);
      expect(new StateStore(dataDir).getPausedProjects()).toEqual(["alpha"]);

      store.setProjectPaused("beta", true);
      expect(new StateStore(dataDir).getPausedProjects().sort()).toEqual(["alpha", "beta"]);

      store.setProjectPaused("alpha", false);
      expect(store.isProjectPaused("alpha")).toBe(false);
      expect(new StateStore(dataDir).getPausedProjects()).toEqual(["beta"]);
    });

    it("is idempotent — pausing an already-paused project doesn't duplicate it", () => {
      const store = new StateStore(tempDataDir());
      store.setProjectPaused("alpha", true);
      store.setProjectPaused("alpha", true);
      expect(store.getPausedProjects()).toEqual(["alpha"]);
    });
  });

  describe("project dormant pin (#152)", () => {
    it("defaults to active, and setProjectDormant/isProjectDormant/getDormantProjects round-trip and persist", () => {
      const dataDir = tempDataDir();
      const store = new StateStore(dataDir);
      expect(store.isProjectDormant("alpha")).toBe(false);
      expect(store.getDormantProjects()).toEqual([]);

      store.setProjectDormant("alpha", true);
      expect(store.isProjectDormant("alpha")).toBe(true);
      expect(store.isProjectDormant("beta")).toBe(false);
      expect(store.getDormantProjects()).toEqual(["alpha"]);
      expect(new StateStore(dataDir).getDormantProjects()).toEqual(["alpha"]);

      store.setProjectDormant("beta", true);
      expect(new StateStore(dataDir).getDormantProjects().sort()).toEqual(["alpha", "beta"]);

      store.setProjectDormant("alpha", false);
      expect(store.isProjectDormant("alpha")).toBe(false);
      expect(new StateStore(dataDir).getDormantProjects()).toEqual(["beta"]);
    });

    it("is idempotent — pinning an already-dormant project doesn't duplicate it", () => {
      const store = new StateStore(tempDataDir());
      store.setProjectDormant("alpha", true);
      store.setProjectDormant("alpha", true);
      expect(store.getDormantProjects()).toEqual(["alpha"]);
    });
  });

  describe("clearLiveFlags", () => {
    it("downgrades running tickets to stalled and clears sessionLive, as crash recovery on daemon restart", () => {
      const dataDir = tempDataDir();
      const store = new StateStore(dataDir);
      store.upsert(ticket(1, { status: "running", sessionLive: true }));

      store.clearLiveFlags();

      const updated = store.get("alpha", 1);
      expect(updated?.status).toBe("stalled");
      expect(updated?.sessionLive).toBe(false);
    });

    it("leaves non-running statuses alone", () => {
      const store = new StateStore(tempDataDir());
      store.upsert(ticket(1, { status: "review", sessionLive: true }));

      store.clearLiveFlags();

      expect(store.get("alpha", 1)?.status).toBe("review");
      expect(store.get("alpha", 1)?.sessionLive).toBe(false);
    });
  });

  describe("spend ledger", () => {
    it("appendSpend adds an entry and getWindowSpend sums entries within the window", () => {
      const store = new StateStore(tempDataDir());
      store.appendSpend(1.5, 5);
      store.appendSpend(2.5, 5);
      expect(store.getWindowSpend(5)).toBeCloseTo(4);
    });

    it("is a no-op for a zero or negative delta", () => {
      const store = new StateStore(tempDataDir());
      store.appendSpend(0, 5);
      store.appendSpend(-1, 5);
      expect(store.getWindowSpend(5)).toBe(0);
    });

    it("prunes entries older than the window when read", () => {
      const dataDir = tempDataDir();
      writeFileSync(
        join(dataDir, "state.json"),
        JSON.stringify({
          tickets: [],
          spendLedger: [
            { at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), usd: 10 },
            { at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), usd: 2 },
          ],
        }),
      );
      const store = new StateStore(dataDir);
      expect(store.getWindowSpend(5)).toBe(2);
    });

    it("prunes the stale entry permanently — it does not reappear once pruned", () => {
      const dataDir = tempDataDir();
      writeFileSync(
        join(dataDir, "state.json"),
        JSON.stringify({
          tickets: [],
          spendLedger: [{ at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), usd: 10 }],
        }),
      );
      const store = new StateStore(dataDir);
      store.getWindowSpend(5);
      expect(store.getWindowSpend(24 * 365)).toBe(0);
    });

    it("prunes stale entries on append too", () => {
      const dataDir = tempDataDir();
      writeFileSync(
        join(dataDir, "state.json"),
        JSON.stringify({
          tickets: [],
          spendLedger: [{ at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), usd: 10 }],
        }),
      );
      const store = new StateStore(dataDir);
      store.appendSpend(1, 5);
      expect(store.getWindowSpend(5)).toBe(1);
    });

    it("persists across instances reading the same data dir", () => {
      const dataDir = tempDataDir();
      new StateStore(dataDir).appendSpend(3, 5);
      expect(new StateStore(dataDir).getWindowSpend(5)).toBe(3);
    });
  });

  describe("getSpendSince", () => {
    it("sums entries at/after the given timestamp without pruning anything", () => {
      const store = new StateStore(tempDataDir());
      store.appendSpend(1, 100000); // old entry, well outside a normal window
      const cutoff = new Date().toISOString();
      store.appendSpend(2, 100000);
      expect(store.getSpendSince(cutoff)).toBeCloseTo(2);
      // The first entry is still there for a wider window — getSpendSince never deletes.
      expect(store.getWindowSpend(100000)).toBeCloseTo(3);
    });

    it("is 0 with an empty ledger", () => {
      const store = new StateStore(tempDataDir());
      expect(store.getSpendSince(new Date(0).toISOString())).toBe(0);
    });
  });

  describe("getLastDigestSentAt/setLastDigestSentAt", () => {
    it("round-trips and persists across instances", () => {
      const dataDir = tempDataDir();
      const store = new StateStore(dataDir);
      expect(store.getLastDigestSentAt()).toBeUndefined();
      store.setLastDigestSentAt("2026-01-02T09:00:00.000Z");
      expect(store.getLastDigestSentAt()).toBe("2026-01-02T09:00:00.000Z");
      expect(new StateStore(dataDir).getLastDigestSentAt()).toBe("2026-01-02T09:00:00.000Z");
      store.setLastDigestSentAt(undefined);
      expect(store.getLastDigestSentAt()).toBeUndefined();
    });
  });

  describe("appendEvent/getEventsSince", () => {
    it("round-trips project/issueNumber/data and filters by timestamp", () => {
      const store = new StateStore(tempDataDir());
      store.appendEvent("auto-merged", { project: "alpha", issueNumber: 3, data: { title: "Fixed it" } });
      const [recorded] = store.getEventsSince(new Date(0).toISOString());
      expect(recorded).toMatchObject({ type: "auto-merged", project: "alpha", issueNumber: 3, data: { title: "Fixed it" } });
      expect(typeof recorded?.at).toBe("string");
    });

    it("excludes events before sinceIso", () => {
      const store = new StateStore(tempDataDir());
      store.appendEvent("stale-claim-released", { project: "alpha" });
      const future = new Date(Date.now() + 60_000).toISOString();
      expect(store.getEventsSince(future)).toEqual([]);
    });

    it("defaults data to {} and omits project/issueNumber when not given", () => {
      const store = new StateStore(tempDataDir());
      store.appendEvent("gate-hold-budget");
      const [recorded] = store.getEventsSince(new Date(0).toISOString());
      expect(recorded).toMatchObject({ type: "gate-hold-budget", data: {} });
      expect(recorded?.project).toBeUndefined();
      expect(recorded?.issueNumber).toBeUndefined();
    });
  });
});

describe("HistoryStore", () => {
  it("starts empty when there is no history file yet", () => {
    const store = new HistoryStore(tempDataDir());
    expect(store.all()).toEqual([]);
  });

  it("add prepends and persists", () => {
    const dataDir = tempDataDir();
    const store = new HistoryStore(dataDir);
    store.add(closed(1, "2026-01-01T00:00:00.000Z"));
    store.add(closed(2, "2026-01-02T00:00:00.000Z"));
    expect(store.all().map((r) => r.issueNumber)).toEqual([2, 1]);
    expect(new HistoryStore(dataDir).all().map((r) => r.issueNumber)).toEqual([2, 1]);
  });

  it("get finds a record by project+issueNumber", () => {
    const store = new HistoryStore(tempDataDir());
    store.add(closed(1, "2026-01-01T00:00:00.000Z"));
    expect(store.get("alpha", 1)?.issueNumber).toBe(1);
    expect(store.get("alpha", 999)).toBeUndefined();
  });

  it("never trims — seeds well past the old 1000-record cap and reads every record back", () => {
    const store = new HistoryStore(tempDataDir());
    for (let i = 0; i < 1010; i++) {
      store.add(closed(i, new Date(2026, 0, 1, 0, 0, i).toISOString()));
    }
    const all = store.all();
    expect(all).toHaveLength(1010);
    expect(all.map((r) => r.issueNumber)).toContain(0);
    expect(all[0]?.issueNumber).toBe(1009);
    expect(all.at(-1)?.issueNumber).toBe(0);
  });
});
