import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClosedTicketRecord, TicketRecord } from "@fleet/shared";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryStore, StateStore, trimHistory } from "./state.ts";

function closed(issueNumber: number, closedAt: string, patch: Partial<ClosedTicketRecord> = {}): ClosedTicketRecord {
  const record: TicketRecord = {
    project: "alpha",
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    branch: `fleet/${issueNumber}`,
    worktreePath: `/tmp/wt/${issueNumber}`,
    status: "review",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 1,
  };
  return { ...record, closedAt, prState: "MERGED", ...patch };
}

describe("trimHistory", () => {
  it("sorts newest first", () => {
    const records = [
      closed(1, "2026-01-01T00:00:00.000Z"),
      closed(2, "2026-01-03T00:00:00.000Z"),
      closed(3, "2026-01-02T00:00:00.000Z"),
    ];
    expect(trimHistory(records).map((r) => r.issueNumber)).toEqual([2, 3, 1]);
  });

  it("caps at the given max", () => {
    const records = Array.from({ length: 10 }, (_, i) => closed(i, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`));
    const trimmed = trimHistory(records, 3);
    expect(trimmed).toHaveLength(3);
    expect(trimmed.map((r) => r.issueNumber)).toEqual([9, 8, 7]);
  });

  it("defaults to keeping the most recent 1000, trimming oldest-first", () => {
    const records = Array.from({ length: 1010 }, (_, i) => closed(i, new Date(2026, 0, 1, 0, 0, i).toISOString()));
    const trimmed = trimHistory(records);
    expect(trimmed).toHaveLength(1000);
    expect(trimmed.map((r) => r.issueNumber)).not.toContain(0);
    expect(trimmed.map((r) => r.issueNumber)).not.toContain(9);
    expect(trimmed[0]?.issueNumber).toBe(1009);
    expect(trimmed.at(-1)?.issueNumber).toBe(10);
  });

  it("leaves entries under the cap untouched aside from sorting", () => {
    const records = Array.from({ length: 5 }, (_, i) => closed(i, new Date(2026, 0, 1, 0, 0, i).toISOString()));
    expect(trimHistory(records)).toHaveLength(5);
  });

  it("does not mutate the input array", () => {
    const records = [closed(1, "2026-01-01T00:00:00.000Z"), closed(2, "2026-01-02T00:00:00.000Z")];
    const copy = [...records];
    trimHistory(records);
    expect(records).toEqual(copy);
  });
});

function ticket(issueNumber: number, patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    branch: `fleet/${issueNumber}`,
    worktreePath: `/tmp/wt/${issueNumber}`,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 1,
    ...patch,
  };
}

const dataDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-state-"));
  dataDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("StateStore", () => {
  it("starts empty when there is no state file yet, creating the data dir", () => {
    const dataDir = join(tempDataDir(), "nested");
    const store = new StateStore(dataDir);
    expect(store.all()).toEqual([]);
  });

  it("falls back to an empty state when the file on disk is corrupt", () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "state.json"), "{not valid json");
    const store = new StateStore(dataDir);
    expect(store.all()).toEqual([]);
  });

  it("strips a leading BOM before parsing on read", () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "state.json"), "﻿" + JSON.stringify({ tickets: [ticket(1)] }));
    const store = new StateStore(dataDir);
    expect(store.get("alpha", 1)?.issueNumber).toBe(1);
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

    it("does not rewrite the file when nothing changed", () => {
      const dataDir = tempDataDir();
      const store = new StateStore(dataDir);
      store.upsert(ticket(1, { status: "review", sessionLive: false }));
      const before = readFileSync(join(dataDir, "state.json"), "utf8");

      store.clearLiveFlags();

      expect(readFileSync(join(dataDir, "state.json"), "utf8")).toBe(before);
    });
  });
});

describe("HistoryStore", () => {
  it("starts empty when there is no history file yet", () => {
    const store = new HistoryStore(tempDataDir());
    expect(store.all()).toEqual([]);
  });

  it("falls back to an empty history when the file on disk is corrupt", () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "history.json"), "not json at all");
    const store = new HistoryStore(dataDir);
    expect(store.all()).toEqual([]);
  });

  it("falls back to an empty history when the file's top-level shape is not an array", () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "history.json"), JSON.stringify({ oops: true }));
    const store = new HistoryStore(dataDir);
    expect(store.all()).toEqual([]);
  });

  it("add prepends and persists, trimming via trimHistory", () => {
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
});
