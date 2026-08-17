import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRecord } from "../test-support.ts";
import { copyTicketTranscripts, readTicketTranscript, sanitizeCwd } from "./transcripts.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("sanitizeCwd", () => {
  it("replaces every non-alphanumeric character with a dash, matching the CLI's own scheme", () => {
    expect(sanitizeCwd("C:\\Users\\j\\github\\.fleet-worktrees\\fleet\\93")).toBe(
      "C--Users-j-github--fleet-worktrees-fleet-93",
    );
  });
});

describe("copyTicketTranscripts", () => {
  const record = makeRecord({ issueNumber: 7, worktreePath: "/tmp/wt/7" });

  it("copies every session transcript from the sanitized-cwd source directory into the archive", () => {
    const claudeProjectsRoot = tempDir("fleet-transcripts-src-");
    const sourceDir = join(claudeProjectsRoot, sanitizeCwd(record.worktreePath));
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "sess-1.jsonl"), '{"type":"user"}\n');

    const dataDirPath = tempDir("fleet-transcripts-dest-");
    copyTicketTranscripts(dataDirPath, record, claudeProjectsRoot);

    const destDir = join(dataDirPath, "transcripts", "alpha", "7");
    expect(readdirSync(destDir)).toEqual(["sess-1.jsonl"]);
    expect(readFileSync(join(destDir, "sess-1.jsonl"), "utf8")).toBe('{"type":"user"}\n');
  });

  it("copies every session file for a ticket that ran through multiple sessions (resume/restart/review)", () => {
    const claudeProjectsRoot = tempDir("fleet-transcripts-src-");
    const sourceDir = join(claudeProjectsRoot, sanitizeCwd(record.worktreePath));
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "sess-1.jsonl"), "first session\n");
    writeFileSync(join(sourceDir, "sess-2.jsonl"), "resumed session\n");
    writeFileSync(join(sourceDir, "sess-3.jsonl"), "restarted session\n");

    const dataDirPath = tempDir("fleet-transcripts-dest-");
    copyTicketTranscripts(dataDirPath, record, claudeProjectsRoot);

    const destDir = join(dataDirPath, "transcripts", "alpha", "7");
    expect(readdirSync(destDir).sort()).toEqual(["sess-1.jsonl", "sess-2.jsonl", "sess-3.jsonl"]);
  });

  it("does not throw and leaves no archive directory when the source directory is missing", () => {
    const claudeProjectsRoot = tempDir("fleet-transcripts-src-");
    const dataDirPath = tempDir("fleet-transcripts-dest-");

    expect(() => copyTicketTranscripts(dataDirPath, record, claudeProjectsRoot)).not.toThrow();
    expect(existsSync(join(dataDirPath, "transcripts"))).toBe(false);
  });

  it("does not throw and leaves no archive directory when the source directory has no session files", () => {
    const claudeProjectsRoot = tempDir("fleet-transcripts-src-");
    mkdirSync(join(claudeProjectsRoot, sanitizeCwd(record.worktreePath)), { recursive: true });
    const dataDirPath = tempDir("fleet-transcripts-dest-");

    expect(() => copyTicketTranscripts(dataDirPath, record, claudeProjectsRoot)).not.toThrow();
    expect(existsSync(join(dataDirPath, "transcripts"))).toBe(false);
  });

  it("ignores non-.jsonl files alongside session transcripts", () => {
    const claudeProjectsRoot = tempDir("fleet-transcripts-src-");
    const sourceDir = join(claudeProjectsRoot, sanitizeCwd(record.worktreePath));
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "sess-1.jsonl"), "session\n");
    writeFileSync(join(sourceDir, ".DS_Store"), "junk");

    const dataDirPath = tempDir("fleet-transcripts-dest-");
    copyTicketTranscripts(dataDirPath, record, claudeProjectsRoot);

    const destDir = join(dataDirPath, "transcripts", "alpha", "7");
    expect(readdirSync(destDir)).toEqual(["sess-1.jsonl"]);
  });
});

describe("readTicketTranscript", () => {
  it("returns undefined when nothing has been archived", () => {
    const dataDirPath = tempDir("fleet-transcripts-dest-");
    expect(readTicketTranscript(dataDirPath, "alpha", 7)).toBeUndefined();
  });

  it("returns the archived file's content", () => {
    const dataDirPath = tempDir("fleet-transcripts-dest-");
    const destDir = join(dataDirPath, "transcripts", "alpha", "7");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "sess-1.jsonl"), '{"type":"user"}\n');

    expect(readTicketTranscript(dataDirPath, "alpha", 7)).toEqual([
      { name: "sess-1.jsonl", content: '{"type":"user"}\n' },
    ]);
  });

  it("orders multiple session files oldest-first by mtime", () => {
    const dataDirPath = tempDir("fleet-transcripts-dest-");
    const destDir = join(dataDirPath, "transcripts", "alpha", "7");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "sess-newer.jsonl"), "newer\n");
    writeFileSync(join(destDir, "sess-older.jsonl"), "older\n");
    const now = new Date();
    utimesSync(join(destDir, "sess-older.jsonl"), now, new Date(now.getTime() - 60_000));
    utimesSync(join(destDir, "sess-newer.jsonl"), now, now);

    const files = readTicketTranscript(dataDirPath, "alpha", 7);
    expect(files?.map((f) => f.name)).toEqual(["sess-older.jsonl", "sess-newer.jsonl"]);
  });
});
