import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ClosedTicketRecord, FleetState, SpendLedgerEntry, TicketRecord } from "@fleet/shared";
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

  return db;
}

/** Test-only: closes every cached connection so a temp dir can be safely rm'd afterward (an open db file blocks deletion on Windows). */
export function closeAllDatabases(): void {
  for (const db of dbCache.values()) db.close();
  dbCache.clear();
}

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
