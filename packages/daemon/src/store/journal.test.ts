import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllDatabases } from "./db.ts";
import { Journal, readJournalTail } from "./journal.ts";

const dataDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-journal-"));
  dataDirs.push(dir);
  return dir;
}

function writeLegacyJournal(dataDir: string, project: string, issueNumber: number, lines: string[]): void {
  const dir = join(dataDir, "journals", project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${issueNumber}.jsonl`), lines.join("\n"));
}

afterEach(() => {
  // An open sqlite handle blocks directory deletion on Windows, so close every
  // cached connection before rm'ing the temp dirs those connections live in.
  closeAllDatabases();
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Journal", () => {
  it("append is readable back via readJournalTail, defaulting v and ts", () => {
    const dataDir = tempDataDir();
    new Journal(dataDir, "alpha", 1).append({ type: "fleet", event: "claimed" });

    const [entry] = readJournalTail(dataDir, "alpha", 1, 10);
    expect(entry?.type).toBe("fleet");
    expect(entry?.event).toBe("claimed");
    expect(entry?.v).toBe(2);
    expect(typeof entry?.ts).toBe("string");
  });

  it("keeps entries scoped to their own project+issue", () => {
    const dataDir = tempDataDir();
    new Journal(dataDir, "alpha", 1).append({ type: "fleet", event: "claimed" });
    new Journal(dataDir, "alpha", 2).append({ type: "fleet", event: "resumed" });
    new Journal(dataDir, "beta", 1).append({ type: "fleet", event: "restarted-by-operator" });

    expect(readJournalTail(dataDir, "alpha", 1, 10).map((e) => e.event)).toEqual(["claimed"]);
    expect(readJournalTail(dataDir, "alpha", 2, 10).map((e) => e.event)).toEqual(["resumed"]);
    expect(readJournalTail(dataDir, "beta", 1, 10).map((e) => e.event)).toEqual(["restarted-by-operator"]);
  });

  it("persists across instances reading the same data dir", () => {
    const dataDir = tempDataDir();
    new Journal(dataDir, "alpha", 1).append({ type: "fleet", event: "claimed" });
    closeAllDatabases();

    expect(readJournalTail(dataDir, "alpha", 1, 10).map((e) => e.event)).toEqual(["claimed"]);
  });
});

describe("readJournalTail", () => {
  it("returns an empty array for a ticket with no entries", () => {
    const dataDir = tempDataDir();
    expect(readJournalTail(dataDir, "alpha", 999, 10)).toEqual([]);
  });

  it("returns entries oldest-first and caps at the requested limit", () => {
    const dataDir = tempDataDir();
    const journal = new Journal(dataDir, "alpha", 1);
    for (let i = 0; i < 5; i++) journal.append({ type: "fleet", event: `step-${i}` });

    const tail = readJournalTail(dataDir, "alpha", 1, 3);

    expect(tail.map((e) => e.event)).toEqual(["step-2", "step-3", "step-4"]);
  });
});

describe("one-time JSONL import", () => {
  it("imports a legacy journal file's lines and archives it", () => {
    const dataDir = tempDataDir();
    writeLegacyJournal(dataDir, "alpha", 7, [
      JSON.stringify({ v: 2, ts: "2026-01-01T00:00:00.000Z", type: "fleet", event: "claimed" }),
      JSON.stringify({ v: 2, ts: "2026-01-01T00:01:00.000Z", type: "assistant", text: "on it" }),
    ]);

    const tail = readJournalTail(dataDir, "alpha", 7, 10);

    expect(tail).toEqual([
      { v: 2, ts: "2026-01-01T00:00:00.000Z", type: "fleet", event: "claimed" },
      { v: 2, ts: "2026-01-01T00:01:00.000Z", type: "assistant", text: "on it" },
    ]);
    expect(existsSync(join(dataDir, "journals", "alpha", "7.jsonl"))).toBe(false);
    expect(existsSync(join(dataDir, "journals", "alpha", "7.jsonl.imported.bak"))).toBe(true);
  });

  it("imports every project/issue file found under journals/", () => {
    const dataDir = tempDataDir();
    writeLegacyJournal(dataDir, "alpha", 1, [JSON.stringify({ ts: "t0", type: "fleet", event: "a" })]);
    writeLegacyJournal(dataDir, "alpha", 2, [JSON.stringify({ ts: "t0", type: "fleet", event: "b" })]);
    writeLegacyJournal(dataDir, "beta", 1, [JSON.stringify({ ts: "t0", type: "fleet", event: "c" })]);

    expect(readJournalTail(dataDir, "alpha", 1, 10).map((e) => e.event)).toEqual(["a"]);
    expect(readJournalTail(dataDir, "alpha", 2, 10).map((e) => e.event)).toEqual(["b"]);
    expect(readJournalTail(dataDir, "beta", 1, 10).map((e) => e.event)).toEqual(["c"]);
  });

  it("skips a corrupt line but keeps the well-formed lines around it, and still archives the file", () => {
    const dataDir = tempDataDir();
    writeLegacyJournal(dataDir, "alpha", 3, [
      JSON.stringify({ ts: "t0", type: "fleet", event: "claimed" }),
      "{not valid json",
      JSON.stringify({ ts: "t2", type: "fleet", event: "finished" }),
    ]);

    const tail = readJournalTail(dataDir, "alpha", 3, 10);

    expect(tail.map((e) => e.event)).toEqual(["claimed", "finished"]);
    expect(existsSync(join(dataDir, "journals", "alpha", "3.jsonl.imported.bak"))).toBe(true);
  });

  it("ignores a trailing blank line", () => {
    const dataDir = tempDataDir();
    writeLegacyJournal(dataDir, "alpha", 4, [JSON.stringify({ ts: "t0", type: "fleet", event: "claimed" }), ""]);

    expect(readJournalTail(dataDir, "alpha", 4, 10).map((e) => e.event)).toEqual(["claimed"]);
  });

  it("is idempotent — a second boot against the same data dir does not duplicate imported entries", () => {
    const dataDir = tempDataDir();
    writeLegacyJournal(dataDir, "alpha", 1, [JSON.stringify({ ts: "t0", type: "fleet", event: "claimed" })]);

    readJournalTail(dataDir, "alpha", 1, 10); // triggers the first import
    closeAllDatabases(); // simulate a process restart: force a real reopen from disk, not the connection cache

    expect(readJournalTail(dataDir, "alpha", 1, 10).map((e) => e.event)).toEqual(["claimed"]);
  });

  it("new entries appended after import land after the imported history", () => {
    const dataDir = tempDataDir();
    writeLegacyJournal(dataDir, "alpha", 1, [JSON.stringify({ ts: "t0", type: "fleet", event: "claimed" })]);

    new Journal(dataDir, "alpha", 1).append({ type: "fleet", event: "resumed" });

    expect(readJournalTail(dataDir, "alpha", 1, 10).map((e) => e.event)).toEqual(["claimed", "resumed"]);
  });
});
