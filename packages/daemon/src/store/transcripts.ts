import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TicketRecord, TicketTranscriptFile } from "@fleet/shared";
import { log } from "../log.ts";

/** Mirrors the Claude CLI's own cwd sanitization for `~/.claude/projects/<sanitized-cwd>`. */
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Copies every session transcript a finished ticket's worktree produced into
 * `<dataDir>/transcripts/<project>/<issue>/`, so the CLI's own full-fidelity
 * transcripts (fleet's journal is lossy by design) survive its ~30-day
 * retention window. A ticket can run through several session IDs over its
 * life (auto-resume, restart, review-feedback resumption each may mint a new
 * one) and `TicketRecord` only keeps the latest, so rather than tracking
 * every ID this globs the sanitized-cwd transcript directory directly: every
 * `*.jsonl` file there belongs to this ticket, since each ticket gets its own
 * worktree path. Never throws — a missing or empty source directory is
 * logged and skipped, since the CLI may have already pruned it.
 */
export function copyTicketTranscripts(
  dataDirPath: string,
  record: Pick<TicketRecord, "project" | "issueNumber" | "worktreePath">,
  claudeProjectsRoot: string = join(homedir(), ".claude", "projects"),
): void {
  const scope = `${record.project}#${record.issueNumber}`;
  const sourceDir = join(claudeProjectsRoot, sanitizeCwd(record.worktreePath));

  let files: string[];
  try {
    files = readdirSync(sourceDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    log("loop", `${scope}: WARNING: no transcript directory at ${sourceDir} — skipping transcript archive`);
    return;
  }

  if (files.length === 0) {
    log("loop", `${scope}: WARNING: transcript directory ${sourceDir} has no session files — skipping transcript archive`);
    return;
  }

  const destDir = join(dataDirPath, "transcripts", record.project, String(record.issueNumber));
  mkdirSync(destDir, { recursive: true });
  for (const file of files) {
    copyFileSync(join(sourceDir, file), join(destDir, file));
  }
  log("loop", `${scope}: archived ${files.length} session transcript(s) to ${destDir}`);
}

/** The archived transcript dir for this ticket, if `copyTicketTranscripts` has populated it. */
export function transcriptDirIfPresent(dataDirPath: string, project: string, issueNumber: number): string | undefined {
  const dir = join(dataDirPath, "transcripts", project, String(issueNumber));
  try {
    if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".jsonl"))) return dir;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Reads every archived session transcript for a ticket, oldest session first
 * (by archive-copy mtime, since session-id filenames carry no chronological
 * order of their own). Returns `undefined` when nothing has been archived yet.
 */
export function readTicketTranscript(
  dataDirPath: string,
  project: string,
  issueNumber: number,
): TicketTranscriptFile[] | undefined {
  const dir = transcriptDirIfPresent(dataDirPath, project, issueNumber);
  if (!dir) return undefined;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map(({ name }) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
}
