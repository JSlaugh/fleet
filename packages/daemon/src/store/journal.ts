import type { DatabaseSync } from "node:sqlite";
import type { JournalEntry } from "@fleet/shared";
import { insertJournalEntry, journalEntriesTail, openDatabase } from "./db.ts";

export class Journal {
  private readonly db: DatabaseSync;

  constructor(dataDir: string, private readonly project: string, private readonly issueNumber: number) {
    this.db = openDatabase(dataDir);
  }

  append(entry: Record<string, unknown>): void {
    insertJournalEntry(this.db, this.project, this.issueNumber, {
      v: 2,
      ts: new Date().toISOString(),
      ...entry,
    } as JournalEntry);
  }
}

/** The most recent `limit` entries of a ticket's journal, oldest first. A ticket with no entries yet yields an empty array. */
export function readJournalTail(dataDir: string, project: string, issueNumber: number, limit: number): JournalEntry[] {
  return journalEntriesTail(openDatabase(dataDir), project, issueNumber, limit);
}
