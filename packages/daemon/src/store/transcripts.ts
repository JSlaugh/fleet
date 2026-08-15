import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TicketRecord } from "@fleet/shared";
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
