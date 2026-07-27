import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FleetState, TicketRecord } from "@fleet/shared";

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
