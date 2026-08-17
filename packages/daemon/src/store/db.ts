import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ClosedTicketRecord, FleetState, JournalEntry, SpendLedgerEntry, TicketRecord } from "@fleet/shared";
import { logError } from "../log.ts";

/**
 * One `DatabaseSync` per resolved data dir, shared by every `StateStore`/`HistoryStore`
 * pointed at it (the daemon opens one of each on the same dir; tests open many). Caching
 * by path is also what makes the one-time JSON import below run exactly once per dir
 * instead of racing between the two stores' constructors.
 */
const dbCache = new Map<string, DatabaseSync>();

export function openDatabase(dataDir: string): DatabaseSync {
  const resolvedDir = resolve(dataDir);
  const cached = dbCache.get(resolvedDir);
  if (cached) return cached;

  mkdirSync(resolvedDir, { recursive: true });
  const dbPath = join(resolvedDir, "fleet.db");
  const isNewDb = !existsSync(dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  createSchema(db);
  dbCache.set(resolvedDir, db);

  if (isNewDb) migrateFromJson(db, resolvedDir);
  // Unlike state.json/history.json above, journals predate fleet.db itself
  // (#130 left them as JSONL on purpose), so most installs hit this with an
  // existing db and a `journals/` dir still full of `.jsonl` files — this
  // can't be gated on `isNewDb`. It's still one-time in effect: imported
  // files are renamed to `*.imported.bak`, so a dir with nothing left to
  // import is a fast no-op scan on every later boot.
  migrateJournalsFromJsonl(db, resolvedDir);

  return db;
}

/** Test-only: closes every cached connection so a temp dir can be safely rm'd afterward (an open db file blocks deletion on Windows). */
export function closeAllDatabases(): void {
  for (const db of dbCache.values()) db.close();
  dbCache.clear();
}

/**
 * `journal_entries` carries no retention policy yet, unlike `daemon_events`
 * below: it's brand new (moved off unbounded-growth JSONL files in #144) and
 * nothing has read it back in production yet to say what's safe to drop.
 * Once that's known, trimming is a one-line indexed DELETE ... WHERE ts < ?,
 * the same shape as insertEvent's cutoff further down this file.
 */
function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      project TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (project, issue_number)
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_project_issue ON history (project, issue_number);
    CREATE INDEX IF NOT EXISTS idx_history_closed_at ON history (closed_at);
    CREATE TABLE IF NOT EXISTS daemon_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spend_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      usd REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daemon_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      project TEXT,
      issue_number INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daemon_events_at ON daemon_events (at);
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      ts TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_journal_entries_project_issue ON journal_entries (project, issue_number);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_ts ON journal_entries (ts);
  `);
}

// --- tickets -----------------------------------------------------------

export function upsertTicket(db: DatabaseSync, record: TicketRecord): void {
  db.prepare(
    `INSERT INTO tickets (project, issue_number, status, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(project, issue_number) DO UPDATE SET status = excluded.status, data = excluded.data`,
  ).run(record.project, record.issueNumber, record.status, JSON.stringify(record));
}

export function getTicket(db: DatabaseSync, project: string, issueNumber: number): TicketRecord | undefined {
  const row = db.prepare(`SELECT data FROM tickets WHERE project = ? AND issue_number = ?`).get(project, issueNumber) as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as TicketRecord) : undefined;
}

export function allTickets(db: DatabaseSync): TicketRecord[] {
  const rows = db.prepare(`SELECT data FROM tickets`).all() as { data: string }[];
  return rows.map((row) => JSON.parse(row.data) as TicketRecord);
}

export function removeTicket(db: DatabaseSync, project: string, issueNumber: number): void {
  db.prepare(`DELETE FROM tickets WHERE project = ? AND issue_number = ?`).run(project, issueNumber);
}

// --- history -------------------------------------------------------------

export function insertHistory(db: DatabaseSync, record: ClosedTicketRecord): void {
  db.prepare(`INSERT INTO history (project, issue_number, status, closed_at, data) VALUES (?, ?, ?, ?, ?)`).run(
    record.project,
    record.issueNumber,
    record.status,
    record.closedAt,
    JSON.stringify(record),
  );
}

export function getHistory(db: DatabaseSync, project: string, issueNumber: number): ClosedTicketRecord | undefined {
  const row = db
    .prepare(`SELECT data FROM history WHERE project = ? AND issue_number = ? ORDER BY closed_at DESC, id DESC LIMIT 1`)
    .get(project, issueNumber) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as ClosedTicketRecord) : undefined;
}

export function allHistory(db: DatabaseSync): ClosedTicketRecord[] {
  const rows = db.prepare(`SELECT data FROM history ORDER BY closed_at DESC, id DESC`).all() as { data: string }[];
  return rows.map((row) => JSON.parse(row.data) as ClosedTicketRecord);
}

// --- daemon-wide key/value state ------------------------------------------

export function getMeta<T>(db: DatabaseSync, key: string): T | undefined {
  const row = db.prepare(`SELECT value FROM daemon_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function setMeta(db: DatabaseSync, key: string, value: unknown): void {
  if (value === undefined) {
    db.prepare(`DELETE FROM daemon_state WHERE key = ?`).run(key);
    return;
  }
  db.prepare(
    `INSERT INTO daemon_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}

// --- spend ledger ----------------------------------------------------------

export function appendSpendRow(db: DatabaseSync, at: string, usd: number): void {
  db.prepare(`INSERT INTO spend_ledger (at, usd) VALUES (?, ?)`).run(at, usd);
}

/** Deletes entries older than `windowHours` and returns what's left, oldest first. */
export function prunedSpendLedger(db: DatabaseSync, windowHours: number): SpendLedgerEntry[] {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM spend_ledger WHERE at < ?`).run(cutoff);
  return db.prepare(`SELECT at, usd FROM spend_ledger ORDER BY at ASC`).all() as unknown as SpendLedgerEntry[];
}

/**
 * Read-only sum of the trailing spend since `sinceIso` — unlike `prunedSpendLedger`
 * (which `getWindowSpend` uses), this never deletes anything. A digest query's window
 * rarely matches the budget gate's own `usageWindowHours`, so pruning on a digest read
 * would risk destroying ledger rows the gate's own (possibly wider) window still needs.
 */
export function sumSpendSince(db: DatabaseSync, sinceIso: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(usd), 0) AS total FROM spend_ledger WHERE at >= ?`).get(sinceIso) as { total: number };
  return row.total;
}

// --- daemon events (digest-worthy occurrences: auto-merges, stale-claim
// releases, claim-gate holds) ------------------------------------------------

export interface DaemonEvent {
  at: string;
  type: string;
  project?: string;
  issueNumber?: number;
  data: Record<string, unknown>;
}

/** Retention ceiling independent of any single caller's query window — see `sumSpendSince`'s comment on why a query window must never drive deletion. */
const EVENT_RETENTION_HOURS = 24 * 30;

export function insertEvent(db: DatabaseSync, event: DaemonEvent): void {
  db.prepare(`INSERT INTO daemon_events (at, type, project, issue_number, data) VALUES (?, ?, ?, ?, ?)`).run(
    event.at,
    event.type,
    event.project ?? null,
    event.issueNumber ?? null,
    JSON.stringify(event.data),
  );
  const cutoff = new Date(Date.now() - EVENT_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM daemon_events WHERE at < ?`).run(cutoff);
}

function toDaemonEvent(row: { at: string; type: string; project: string | null; issue_number: number | null; data: string }): DaemonEvent {
  return {
    at: row.at,
    type: row.type,
    project: row.project ?? undefined,
    issueNumber: row.issue_number ?? undefined,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

export function eventsSince(db: DatabaseSync, sinceIso: string): DaemonEvent[] {
  const rows = db.prepare(`SELECT at, type, project, issue_number, data FROM daemon_events WHERE at >= ? ORDER BY at ASC`).all(
    sinceIso,
  ) as { at: string; type: string; project: string | null; issue_number: number | null; data: string }[];
  return rows.map(toDaemonEvent);
}

// --- journal entries ---------------------------------------------------

export function insertJournalEntry(db: DatabaseSync, project: string, issueNumber: number, entry: JournalEntry): void {
  db.prepare(`INSERT INTO journal_entries (project, issue_number, ts, data) VALUES (?, ?, ?, ?)`).run(
    project,
    issueNumber,
    entry.ts,
    JSON.stringify(entry),
  );
}

/** The most recent `limit` entries for one ticket, oldest first — `id` (insertion order) breaks ties within the same `ts`. */
export function journalEntriesTail(db: DatabaseSync, project: string, issueNumber: number, limit: number): JournalEntry[] {
  const rows = db
    .prepare(`SELECT data FROM journal_entries WHERE project = ? AND issue_number = ? ORDER BY id DESC LIMIT ?`)
    .all(project, issueNumber, limit) as { data: string }[];
  return rows.reverse().map((row) => JSON.parse(row.data) as JournalEntry);
}

// --- one-time JSON import --------------------------------------------------

/**
 * Runs once, only when `fleet.db` didn't exist before this boot. Imports
 * `state.json`/`history.json` if present, then renames them to `*.imported.bak`
 * — never deletes — so a second boot (db already exists) is a no-op and the
 * originals stay around as a paper trail.
 */
function migrateFromJson(db: DatabaseSync, dataDir: string): void {
  importStateJson(db, dataDir);
  importHistoryJson(db, dataDir);
}

function importStateJson(db: DatabaseSync, dataDir: string): void {
  const path = join(dataDir, "state.json");
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as FleetState;
    for (const ticket of parsed.tickets ?? []) upsertTicket(db, ticket);
    if (parsed.pausedUntil !== undefined) setMeta(db, "pausedUntil", parsed.pausedUntil);
    if (parsed.paused !== undefined) setMeta(db, "paused", parsed.paused);
    if (parsed.pausedProjects !== undefined) setMeta(db, "pausedProjects", parsed.pausedProjects);
    for (const entry of parsed.spendLedger ?? []) appendSpendRow(db, entry.at, entry.usd);
  } catch (err) {
    logError("store", `state.json exists but failed to import — starting with empty ticket state`, err);
  }
  renameSync(path, `${path}.imported.bak`);
}

function importHistoryJson(db: DatabaseSync, dataDir: string): void {
  const path = join(dataDir, "history.json");
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
    if (Array.isArray(parsed)) {
      for (const record of parsed as ClosedTicketRecord[]) insertHistory(db, record);
    }
  } catch (err) {
    logError("store", `history.json exists but failed to import — starting with empty history`, err);
  }
  renameSync(path, `${path}.imported.bak`);
}

/**
 * Scans `<dataDir>/journals/<project>/<issueNumber>.jsonl` for every project
 * dir and imports each file's lines into `journal_entries`, then renames the
 * file to `*.imported.bak` — the same never-delete archive pattern as
 * `importStateJson`/`importHistoryJson`, just fanned out over many files
 * instead of one. A single malformed line is logged and skipped rather than
 * losing the rest of that ticket's history.
 */
function migrateJournalsFromJsonl(db: DatabaseSync, dataDir: string): void {
  const journalsDir = join(dataDir, "journals");
  if (!existsSync(journalsDir)) return;
  for (const projectEntry of readdirSync(journalsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const project = projectEntry.name;
    const projectDir = join(journalsDir, project);
    for (const file of readdirSync(projectDir)) {
      const match = /^(\d+)\.jsonl$/.exec(file);
      if (!match) continue;
      importJournalFile(db, project, Number(match[1]), join(projectDir, file));
    }
  }
}

function importJournalFile(db: DatabaseSync, project: string, issueNumber: number, path: string): void {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JournalEntry;
        insertJournalEntry(db, project, issueNumber, { ...entry, ts: entry.ts ?? new Date().toISOString() });
      } catch (err) {
        logError("store", `a line in ${path} failed to parse — skipping just that entry`, err);
      }
    }
  } catch (err) {
    logError("store", `${path} exists but failed to import — some journal history for ${project}#${issueNumber} may be missing`, err);
  }
  renameSync(path, `${path}.imported.bak`);
}
