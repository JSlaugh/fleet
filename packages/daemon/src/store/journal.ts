import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JournalEntry } from "@fleet/shared";
import { logError } from "../log.ts";

export class Journal {
  private readonly filePath: string;

  constructor(dataDir: string, project: string, issueNumber: number) {
    this.filePath = join(dataDir, "journals", project, `${issueNumber}.jsonl`);
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  append(entry: Record<string, unknown>): void {
    appendFileSync(this.filePath, `${JSON.stringify({ v: 2, ts: new Date().toISOString(), ...entry })}\n`);
  }
}

/** The most recent `limit` entries of a ticket's journal, oldest first. A missing file or a corrupt line yields an empty array rather than throwing. */
export function readJournalTail(dataDir: string, project: string, issueNumber: number, limit: number): JournalEntry[] {
  const file = join(dataDir, "journals", project, `${issueNumber}.jsonl`);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as JournalEntry);
  } catch (err) {
    logError("store", `reading journal for ${project}#${issueNumber}`, err);
    return [];
  }
}
