import type { DatabaseSync } from "node:sqlite";
import type { ClosedTicketRecord, TicketRecord } from "@fleet/shared";
import {
  allHistory,
  allTickets,
  appendSpendRow,
  type DaemonEvent,
  eventsSince,
  getHistory,
  getMeta,
  getTicket,
  insertEvent,
  insertHistory,
  openDatabase,
  prunedSpendLedger,
  removeTicket,
  setMeta,
  sumSpendSince,
  upsertTicket,
} from "./db.ts";

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDatabase(dataDir);
  }

  get(project: string, issueNumber: number): TicketRecord | undefined {
    return getTicket(this.db, project, issueNumber);
  }

  all(): TicketRecord[] {
    return allTickets(this.db);
  }

  upsert(record: TicketRecord): void {
    upsertTicket(this.db, record);
  }

  update(project: string, issueNumber: number, patch: Partial<TicketRecord>): TicketRecord | undefined {
    const record = this.get(project, issueNumber);
    if (!record) return undefined;
    const updated = { ...record, ...patch };
    this.upsert(updated);
    return updated;
  }

  remove(project: string, issueNumber: number): void {
    removeTicket(this.db, project, issueNumber);
  }

  getPausedUntil(): string | undefined {
    return getMeta<string>(this.db, "pausedUntil");
  }

  setPausedUntil(pausedUntil: string | undefined): void {
    setMeta(this.db, "pausedUntil", pausedUntil);
  }

  getPaused(): boolean {
    return getMeta<boolean>(this.db, "paused") ?? false;
  }

  setPaused(paused: boolean): void {
    setMeta(this.db, "paused", paused);
  }

  getPausedProjects(): string[] {
    return [...(getMeta<string[]>(this.db, "pausedProjects") ?? [])];
  }

  isProjectPaused(project: string): boolean {
    return this.getPausedProjects().includes(project);
  }

  setProjectPaused(project: string, paused: boolean): void {
    const projects = new Set(getMeta<string[]>(this.db, "pausedProjects") ?? []);
    if (paused) projects.add(project);
    else projects.delete(project);
    setMeta(this.db, "pausedProjects", [...projects]);
  }

  /**
   * Sums ledger entries within the trailing `windowHours`, pruning anything
   * older off the stored ledger first so it never grows past what the widest
   * window in use actually needs.
   */
  getWindowSpend(windowHours: number): number {
    return prunedSpendLedger(this.db, windowHours).reduce((sum, entry) => sum + entry.usd, 0);
  }

  /** Appends one spend delta (never a running total) and prunes anything past `windowHours`. A non-positive delta is a no-op. */
  appendSpend(usd: number, windowHours: number): void {
    if (usd <= 0) return;
    prunedSpendLedger(this.db, windowHours);
    appendSpendRow(this.db, new Date().toISOString(), usd);
  }

  /** Read-only spend sum since `sinceIso` — for a digest's own window, which a caller must not let prune the budget gate's separately-windowed ledger. See `sumSpendSince`. */
  getSpendSince(sinceIso: string): number {
    return sumSpendSince(this.db, sinceIso);
  }

  getLastDigestSentAt(): string | undefined {
    return getMeta<string>(this.db, "lastDigestSentAt");
  }

  setLastDigestSentAt(at: string | undefined): void {
    setMeta(this.db, "lastDigestSentAt", at);
  }

  /** Appends one digest-worthy occurrence (auto-merge, stale-claim release, claim-gate hold). */
  appendEvent(type: string, opts: { project?: string; issueNumber?: number; data?: Record<string, unknown> } = {}): void {
    insertEvent(this.db, { at: new Date().toISOString(), type, project: opts.project, issueNumber: opts.issueNumber, data: opts.data ?? {} });
  }

  getEventsSince(sinceIso: string): DaemonEvent[] {
    return eventsSince(this.db, sinceIso);
  }

  clearLiveFlags(): void {
    for (const ticket of this.all()) {
      let changed = false;
      const updated = { ...ticket };
      if (updated.sessionLive) {
        updated.sessionLive = false;
        changed = true;
      }
      if (updated.status === "running") {
        updated.status = "stalled";
        changed = true;
      }
      if (changed) this.upsert(updated);
    }
  }
}

/**
 * Archive of tickets removed from `StateStore` once their PR and issue both
 * close — `cleanupFinished` deletes the live `TicketRecord`, so this is the
 * only surviving trace of a finished ticket for the dashboard's Done column.
 * Unbounded: unlike the old JSON file, nothing here is ever trimmed.
 */
export class HistoryStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = openDatabase(dataDir);
  }

  add(record: ClosedTicketRecord): void {
    insertHistory(this.db, record);
  }

  get(project: string, issueNumber: number): ClosedTicketRecord | undefined {
    return getHistory(this.db, project, issueNumber);
  }

  all(): ClosedTicketRecord[] {
    return allHistory(this.db);
  }
}
