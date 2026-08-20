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

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    // A second daemon pointed at the same dataDir should wait briefly (and then
    // fail coherently) rather than throw a raw SQLITE_BUSY on its first write.
    db.exec("PRAGMA busy_timeout = 5000");
    createSchema(db);
  } catch (err) {
    throw new Error(
      `could not open ${dbPath} — corrupt database or another daemon running against this dataDir. ` +
        `GitHub labels are the source of truth, so moving fleet.db aside rebuilds operational state from the repos. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  dbCache.set(resolvedDir, db);

  // Both importers run on every boot and gate per-file on a daemon_state meta
  // key committed in the same transaction as the imported rows — the db itself
  // is the migration ledger, so a crash or a locked file can neither strand a
  // legacy file unimported nor import one twice. The renames to
  // `*.imported.bak` are pure archival and best-effort.
  migrateFromJson(db, resolvedDir);
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
    DROP INDEX IF EXISTS idx_journal_entries_ts;
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

// --- legacy JSON import -----------------------------------------------------

/**
 * Legacy-file import, gated per file on a `daemon_state` meta key that commits
 * in the same transaction as the imported rows — the db itself is the ledger
 * of what's been imported, so this is safe (and cheap) to run on every boot:
 *
 * - transient read failure → nothing committed, no key, retried next boot;
 * - malformed file → archived to `*.failed.bak` and latched, never retried;
 * - crash mid-import → transaction rolls back, clean retry next boot;
 * - crash after commit → key present, file skipped (rename is re-attempted).
 *
 * A missing file also latches its key: matching the old "only when fleet.db is
 * new" semantics, a legacy file appearing *later* next to a live db must not
 * import over current state.
 */
function migrateFromJson(db: DatabaseSync, dataDir: string): void {
  importStateJson(db, dataDir);
  importHistoryJson(db, dataDir);
}

/** Best-effort archival rename — the meta key is the real gate, so a locked file just logs and stays put. */
function archiveImported(path: string, suffix: string): void {
  try {
    renameSync(path, `${path}${suffix}`);
  } catch (err) {
    logError("store", `${path} imported but could not be renamed to ${path}${suffix} — safe to remove or rename by hand`, err);
  }
}

/** The shared gate/transaction/archive shell around one legacy file's import — see `migrateFromJson`'s contract table. */
function importLegacyFile(db: DatabaseSync, path: string, metaKey: string, importRaw: (raw: string) => void): void {
  if (getMeta<boolean>(db, metaKey)) {
    if (existsSync(path)) archiveImported(path, ".imported.bak");
    return;
  }
  if (!existsSync(path)) {
    setMeta(db, metaKey, true);
    return;
  }
  let raw: string;
  try {
    raw = stripBom(readFileSync(path, "utf8"));
  } catch (err) {
    logError("store", `${path} exists but could not be read — leaving it in place to retry on the next boot`, err);
    return;
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      importRaw(raw);
      setMeta(db, metaKey, true);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Malformed content is deterministic — archiving and latching beats
      // re-logging the same parse error on every boot forever.
      logError("store", `${path} is malformed and was not imported — archived as ${path}.failed.bak`, err);
      setMeta(db, metaKey, true);
      archiveImported(path, ".failed.bak");
      return;
    }
    logError("store", `${path} failed to import — leaving it in place to retry on the next boot`, err);
    return;
  }
  archiveImported(path, ".imported.bak");
}

/** UTF-8 BOM strip (code point U+FEFF), kept out of regex literals for editability. */
function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function importStateJson(db: DatabaseSync, dataDir: string): void {
  importLegacyFile(db, join(dataDir, "state.json"), "imported:state.json", (raw) => {
    const parsed = JSON.parse(raw) as FleetState;
    for (const ticket of parsed.tickets ?? []) upsertTicket(db, ticket);
    if (parsed.pausedUntil !== undefined) setMeta(db, "pausedUntil", parsed.pausedUntil);
    if (parsed.paused !== undefined) setMeta(db, "paused", parsed.paused);
    if (parsed.pausedProjects !== undefined) setMeta(db, "pausedProjects", parsed.pausedProjects);
    for (const entry of parsed.spendLedger ?? []) appendSpendRow(db, entry.at, entry.usd);
  });
}

function importHistoryJson(db: DatabaseSync, dataDir: string): void {
  importLegacyFile(db, join(dataDir, "history.json"), "imported:history.json", (raw) => {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const record of parsed as ClosedTicketRecord[]) insertHistory(db, record);
    }
  });
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
  // Same gate/transaction shell as state/history: without it, a crash between
  // the inserts and the rename would re-import the whole file next boot and
  // permanently inflate the stats `cleanupFinished` snapshots at close.
  importLegacyFile(db, path, `imported:journal:${project}#${issueNumber}`, (raw) => {
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as JournalEntry;
        insertJournalEntry(db, project, issueNumber, { ...entry, ts: entry.ts ?? new Date().toISOString() });
      } catch (err) {
        logError("store", `a line in ${path} failed to parse — skipping just that entry`, err);
      }
    }
  });
}
