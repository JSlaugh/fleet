import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export class Journal {
  private readonly filePath: string;

  constructor(dataDir: string, project: string, issueNumber: number) {
    this.filePath = join(dataDir, "journals", project, `${issueNumber}.jsonl`);
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  append(entry: Record<string, unknown>): void {
    appendFileSync(this.filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  }
}
