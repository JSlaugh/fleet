import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { JournalEntry, ProjectConfig, TicketRecord } from "@fleet/shared";
import { shortModelName } from "@fleet/shared";
import { collectBranchSummary } from "../github/worktree.ts";
import { logError } from "../log.ts";
import { activityNote } from "../session/worker.ts";
import { readJournalTail } from "../store/journal.ts";
import { key } from "./context.ts";

/** How many meaningful (text or tool-use) journal entries to surface in "What was attempted". */
const JOURNAL_TAIL_ENTRIES = 10;
/** Raw journal lines fetched before filtering down to the meaningful tail — generous enough that quiet turns don't starve it. */
const JOURNAL_FETCH_LIMIT = 150;
/** Overall comment length cap so a long journal or file list can't blow up the status comment. */
const POST_MORTEM_CHAR_LIMIT = 3000;

export interface PostMortemWorkInProgress {
  /** `git log --oneline` against the base, empty string when there are no commits. */
  commits: string;
  filesChanged: string[];
}

export interface PostMortemInput {
  /** The sentence introducing the error, e.g. "The worker run failed:" — differs per call site. */
  leadLine: string;
  error: string;
  /** The existing retry instructions for the terminal state being reported. */
  retryHint: string;
  record?: TicketRecord;
  /** Raw journal tail, oldest first — filtered down to meaningful entries by this function. */
  journalTail: JournalEntry[];
  /** `undefined` when the worktree is gone/unreachable — that whole section is skipped. */
  workInProgress?: PostMortemWorkInProgress;
  /** Path to the archived transcript directory, if one exists. */
  transcriptPath?: string;
}

function reviewOutcomeLine(outcome: TicketRecord["machineReviewOutcome"]): string | undefined {
  switch (outcome) {
    case "passed":
      return "passed";
    case "findings":
      return "found issues (fix round attempted)";
    case "skipped":
    case "pending":
      return "skipped (reviewer unavailable)";
    default:
      return undefined;
  }
}

function errorSection(leadLine: string, error: string): string {
  return [`**Error**`, leadLine, error].filter(Boolean).join("\n\n");
}

function attemptHistorySection(record: TicketRecord | undefined): string | undefined {
  if (!record) return undefined;
  const lines: string[] = [];
  if (record.model) {
    const tags = [record.elevated ? "elevated" : undefined, record.autoElevated ? "auto-elevated" : undefined]
      .filter(Boolean)
      .join(", ");
    lines.push(`- Model: ${shortModelName(record.model)}${tags ? ` (${tags})` : ""}`);
  }
  if (record.autoResumed) lines.push(`- Auto-resumed from a stall`);
  const reviewLine = reviewOutcomeLine(record.machineReviewOutcome);
  if (reviewLine) lines.push(`- Machine review: ${reviewLine}`);
  if (typeof record.costUsd === "number" && record.costUsd > 0) lines.push(`- Cost so far: $${record.costUsd.toFixed(2)}`);
  if (lines.length === 0) return undefined;
  return [`**Attempt history**`, lines.join("\n")].join("\n\n");
}

function whatWasAttemptedSection(lastSummary: string | undefined, journalTail: JournalEntry[]): string | undefined {
  const notes = journalTail
    .map((entry) => activityNote(entry))
    .filter((note): note is string => Boolean(note))
    .slice(-JOURNAL_TAIL_ENTRIES);
  if (!lastSummary && notes.length === 0) return undefined;
  const parts = [`**What was attempted**`];
  if (lastSummary) parts.push(lastSummary);
  if (notes.length > 0) parts.push(notes.map((note) => `- ${note}`).join("\n"));
  return parts.join("\n\n");
}

function workInProgressSection(wip: PostMortemWorkInProgress | undefined): string | undefined {
  if (!wip) return undefined;
  const parts = [`**Work in progress**`];
  parts.push(wip.commits ? `Commits:\n${wip.commits}` : "No commits on this branch.");
  if (wip.filesChanged.length > 0) {
    parts.push(`Files changed:\n${wip.filesChanged.map((f) => `- \`${f}\``).join("\n")}`);
  }
  return parts.join("\n\n");
}

function deepDivePointersSection(sessionId: string | undefined, transcriptPath: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const parts = [
    `**Deep-dive pointers**`,
    `Session: \`${sessionId}\` — resume locally with \`claude --resume ${sessionId}\` (works from any directory).`,
  ];
  if (transcriptPath) parts.push(`Archived transcript: \`${transcriptPath}\``);
  return parts.join("\n\n");
}

function nextStepsSection(retryHint: string): string | undefined {
  if (!retryHint) return undefined;
  return [`**Next steps**`, retryHint].join("\n\n");
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[post-mortem truncated at ${limit} characters — see the journal/transcript for the rest]`;
}

/**
 * Assembles a deterministic (no LLM) failure post-mortem from data fleet
 * already holds. Every section is best-effort: missing input just drops that
 * section rather than producing a placeholder or throwing.
 */
export function buildFailurePostMortem(input: PostMortemInput): string {
  const sections = [
    errorSection(input.leadLine, input.error),
    attemptHistorySection(input.record),
    whatWasAttemptedSection(input.record?.lastSummary, input.journalTail),
    workInProgressSection(input.workInProgress),
    deepDivePointersSection(input.record?.sessionId, input.transcriptPath),
    nextStepsSection(input.retryHint),
  ].filter((section): section is string => Boolean(section));
  return truncate(sections.join("\n\n"), POST_MORTEM_CHAR_LIMIT);
}

/** The archived transcript dir for this ticket, if `copyTicketTranscripts` has populated it. */
function transcriptDirIfPresent(dataDirPath: string, project: string, issueNumber: number): string | undefined {
  const dir = join(dataDirPath, "transcripts", project, String(issueNumber));
  try {
    if (existsSync(dir) && readdirSync(dir).length > 0) return dir;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Gathers the best-effort inputs to `buildFailurePostMortem` — journal tail,
 * branch commits/files (only if the worktree still exists), archived
 * transcript path — and assembles the comment body. Never throws: any source
 * that fails to read is logged and simply omitted, same policy as
 * `upsertStatusComment`'s own callers.
 */
export async function gatherFailurePostMortem(
  dataDirPath: string,
  project: ProjectConfig,
  issue: { number: number },
  record: TicketRecord | undefined,
  opts: { leadLine: string; error: string; retryHint: string },
): Promise<string> {
  const scope = key(project.name, issue.number);
  try {
    let journalTail: JournalEntry[] = [];
    try {
      journalTail = readJournalTail(dataDirPath, project.name, issue.number, JOURNAL_FETCH_LIMIT);
    } catch (err) {
      logError("loop", `${scope}: could not read the journal for the failure post-mortem`, err);
    }

    let workInProgress: PostMortemWorkInProgress | undefined;
    if (record?.worktreePath && existsSync(record.worktreePath)) {
      try {
        workInProgress = await collectBranchSummary(project, record.worktreePath);
      } catch (err) {
        logError("loop", `${scope}: could not collect the branch summary for the failure post-mortem`, err);
      }
    }

    const transcriptPath = record ? transcriptDirIfPresent(dataDirPath, project.name, issue.number) : undefined;

    return buildFailurePostMortem({
      leadLine: opts.leadLine,
      error: opts.error,
      retryHint: opts.retryHint,
      record,
      journalTail,
      workInProgress,
      transcriptPath,
    });
  } catch (err) {
    logError("loop", `${scope}: failure post-mortem assembly errored — falling back to a plain comment`, err);
    return [opts.leadLine, opts.error, opts.retryHint].filter(Boolean).join("\n\n");
  }
}
