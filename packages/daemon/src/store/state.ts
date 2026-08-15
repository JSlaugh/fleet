import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClosedTicketRecord, FleetState, SpendLedgerEntry, TicketRecord } from "@fleet/shared";

/** How many archived tickets `HistoryStore` keeps on disk. */
const HISTORY_LIMIT = 1000;

/** Newest-first, capped to `max` — applied on every write so the file never grows unbounded. */
export function trimHistory(records: ClosedTicketRecord[], max: number = HISTORY_LIMIT): ClosedTicketRecord[] {
  return [...records].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt)).slice(0, max);
}

export class StateStore {
  private readonly filePath: string;
  private state: FleetState;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "state.json");
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.state = this.read();
  }

  private read(): FleetState {
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, "")) as FleetState;
    } catch {
      return { tickets: [] };
    }
  }

  private write(): void {
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  get(project: string, issueNumber: number): TicketRecord | undefined {
    return this.state.tickets.find((t) => t.project === project && t.issueNumber === issueNumber);
  }

  all(): TicketRecord[] {
    return [...this.state.tickets];
  }

  upsert(record: TicketRecord): void {
    const index = this.state.tickets.findIndex(
      (t) => t.project === record.project && t.issueNumber === record.issueNumber,
    );
    if (index === -1) this.state.tickets.push(record);
    else this.state.tickets[index] = record;
    this.write();
  }

  update(project: string, issueNumber: number, patch: Partial<TicketRecord>): TicketRecord | undefined {
    const record = this.get(project, issueNumber);
    if (!record) return undefined;
    const updated = { ...record, ...patch };
    this.upsert(updated);
    return updated;
  }

  remove(project: string, issueNumber: number): void {
    const index = this.state.tickets.findIndex((t) => t.project === project && t.issueNumber === issueNumber);
    if (index === -1) return;
    this.state.tickets.splice(index, 1);
    this.write();
  }

  getPausedUntil(): string | undefined {
    return this.state.pausedUntil;
  }

  setPausedUntil(pausedUntil: string | undefined): void {
    this.state.pausedUntil = pausedUntil;
    this.write();
  }

  getPaused(): boolean {
    return this.state.paused ?? false;
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
    this.write();
  }

  getPausedProjects(): string[] {
    return [...(this.state.pausedProjects ?? [])];
  }

  isProjectPaused(project: string): boolean {
    return (this.state.pausedProjects ?? []).includes(project);
  }

  setProjectPaused(project: string, paused: boolean): void {
    const projects = new Set(this.state.pausedProjects ?? []);
    if (paused) projects.add(project);
    else projects.delete(project);
    this.state.pausedProjects = [...projects];
    this.write();
  }

  /**
   * Sums ledger entries within the trailing `windowHours`, pruning anything
   * older off the stored ledger first so it never grows past what the widest
   * window in use actually needs.
   */
  getWindowSpend(windowHours: number): number {
    return this.prunedLedger(windowHours).reduce((sum, entry) => sum + entry.usd, 0);
  }

  /** Appends one spend delta (never a running total) and prunes anything past `windowHours`. A non-positive delta is a no-op. */
  appendSpend(usd: number, windowHours: number): void {
    if (usd <= 0) return;
    this.state.spendLedger = [...this.prunedLedger(windowHours), { at: new Date().toISOString(), usd }];
    this.write();
  }

  private prunedLedger(windowHours: number): SpendLedgerEntry[] {
    const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
    const ledger = this.state.spendLedger ?? [];
    const pruned = ledger.filter((entry) => Date.parse(entry.at) >= cutoff);
    if (pruned.length !== ledger.length) {
      this.state.spendLedger = pruned;
      this.write();
    }
    return pruned;
  }

  clearLiveFlags(): void {
    let changed = false;
    for (const ticket of this.state.tickets) {
      if (ticket.sessionLive) {
        ticket.sessionLive = false;
        changed = true;
      }
      if (ticket.status === "running") {
        ticket.status = "stalled";
        changed = true;
      }
    }
    if (changed) this.write();
  }
}

/**
 * Archive of tickets removed from `StateStore` once their PR and issue both
 * close — `cleanupFinished` deletes the live `TicketRecord`, so this is the
 * only surviving trace of a finished ticket for the dashboard's Done column.
 */
export class HistoryStore {
  private readonly filePath: string;
  private records: ClosedTicketRecord[];

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "history.json");
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.records = this.read();
  }

  private read(): ClosedTicketRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, "")) as ClosedTicketRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private write(): void {
    writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }

  add(record: ClosedTicketRecord): void {
    this.records = trimHistory([record, ...this.records]);
    this.write();
  }

  get(project: string, issueNumber: number): ClosedTicketRecord | undefined {
    return this.records.find((r) => r.project === project && r.issueNumber === issueNumber);
  }

  all(): ClosedTicketRecord[] {
    return [...this.records];
  }
}
