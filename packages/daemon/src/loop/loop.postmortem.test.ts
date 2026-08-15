import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JournalEntry, TicketRecord } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import { makeProject, makeRecord } from "../test-support.ts";
import { buildFailurePostMortem, gatherFailurePostMortem, type PostMortemInput } from "./postmortem.ts";

vi.mock("../github/worktree.ts", () => ({
  collectBranchSummary: vi.fn(async () => ({ commits: "abc123 fix the thing", filesChanged: ["src/a.ts", "src/b.ts"] })),
}));

const worktreeMod = await import("../github/worktree.ts");

const project = makeProject();

/** This file's ticket is issue 7 throughout; keep a local wrapper with those defaults over the shared factory. */
function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    sessionId: "sess-7",
    costUsd: 3.5,
    ...patch,
  });
}

const baseOpts = {
  leadLine: "The worker run failed:",
  error: "SDK query rejected",
  retryHint: "Re-label with `fleet:ready` to retry, or reply from the dashboard to resume.",
};

function baseInput(patch: Partial<PostMortemInput> = {}): PostMortemInput {
  return { ...baseOpts, journalTail: [], ...patch };
}

describe("buildFailurePostMortem", () => {
  it("renders every section when full data is available", () => {
    const md = buildFailurePostMortem(
      baseInput({
        record: record({ model: "claude-opus-5", elevated: true, autoResumed: true, machineReviewOutcome: "findings" }),
        journalTail: [
          { ts: "t1", type: "assistant", text: "investigating the failing test" },
          { ts: "t2", type: "assistant", tools: ["Bash"] },
        ],
        workInProgress: { commits: "abc123 wip commit", filesChanged: ["src/a.ts"] },
        transcriptPath: "/data/transcripts/alpha/7",
      }),
    );

    expect(md).toContain("**Error**");
    expect(md).toContain("SDK query rejected");
    expect(md).toContain("**Attempt history**");
    expect(md).toContain("opus-5");
    expect(md).toContain("elevated");
    expect(md).toContain("Auto-resumed");
    expect(md).toContain("found issues");
    expect(md).toContain("$3.50");
    expect(md).toContain("**What was attempted**");
    expect(md).toContain("investigating the failing test");
    expect(md).toContain("using Bash");
    expect(md).toContain("**Work in progress**");
    expect(md).toContain("abc123 wip commit");
    expect(md).toContain("src/a.ts");
    expect(md).toContain("**Deep-dive pointers**");
    expect(md).toContain("claude --resume sess-7");
    expect(md).toContain("/data/transcripts/alpha/7");
    expect(md).toContain("**Next steps**");
    expect(md).toContain(baseOpts.retryHint);
  });

  it("degrades to just Error and Next steps with no record, no journal, no worktree", () => {
    const md = buildFailurePostMortem(baseInput());

    expect(md).toContain("**Error**");
    expect(md).toContain("**Next steps**");
    expect(md).not.toContain("**Attempt history**");
    expect(md).not.toContain("**What was attempted**");
    expect(md).not.toContain("**Work in progress**");
    expect(md).not.toContain("**Deep-dive pointers**");
  });

  it("explicitly notes when the worktree exists but has no commits", () => {
    const md = buildFailurePostMortem(baseInput({ workInProgress: { commits: "", filesChanged: [] } }));

    expect(md).toContain("**Work in progress**");
    expect(md).toContain("No commits on this branch.");
  });

  it("omits the deep-dive section without a session id even if a transcript path is somehow set", () => {
    const md = buildFailurePostMortem(baseInput({ transcriptPath: "/data/transcripts/alpha/7" }));

    expect(md).not.toContain("**Deep-dive pointers**");
  });

  it("skips attempt-history fields that are absent on the record", () => {
    const md = buildFailurePostMortem(baseInput({ record: record({ model: undefined, costUsd: 0 }) }));

    expect(md).not.toContain("**Attempt history**");
  });

  it("caps the assembled comment at the character limit even with a long journal/summary", () => {
    const journalTail: JournalEntry[] = Array.from({ length: 50 }, (_, i) => ({
      ts: `t${i}`,
      type: "assistant",
      text: `step ${i}: `.padEnd(500, "x"),
    }));
    const hugeSummary = "the worker wrote a very long summary. ".repeat(300);

    const md = buildFailurePostMortem(baseInput({ record: record({ lastSummary: hugeSummary }), journalTail }));

    expect(md.length).toBeLessThanOrEqual(3200);
    expect(md).toContain("truncated");
  });

  it("only surfaces the last 10 meaningful journal entries, not every entry", () => {
    const journalTail: JournalEntry[] = Array.from({ length: 20 }, (_, i) => ({
      ts: `t${i}`,
      type: "assistant",
      text: `entry-${i}`,
    }));

    const md = buildFailurePostMortem(baseInput({ journalTail }));

    expect(md).not.toContain("entry-0\n");
    expect(md).toContain("entry-19");
  });
});

describe("gatherFailurePostMortem", () => {
  function makeDataDir(): string {
    return mkdtempSync(join(tmpdir(), "fleet-postmortem-"));
  }

  function writeJournal(dataDir: string, issueNumber: number, entries: Record<string, unknown>[]): void {
    const dir = join(dataDir, "journals", "alpha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${issueNumber}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
  }

  it("includes journal-derived content and skips the worktree section when the worktree path doesn't exist", async () => {
    const dataDir = makeDataDir();
    writeJournal(dataDir, 7, [
      { ts: "t1", type: "assistant", text: "reading the failing test" },
      { ts: "t2", type: "result", subtype: "error_during_execution" },
    ]);

    const md = await gatherFailurePostMortem(dataDir, project, { number: 7 }, record({ worktreePath: "/does/not/exist" }), baseOpts);

    expect(md).toContain("reading the failing test");
    expect(md).not.toContain("**Work in progress**");
    expect(worktreeMod.collectBranchSummary).not.toHaveBeenCalled();
  });

  it("collects the branch summary when the worktree path exists", async () => {
    const dataDir = makeDataDir();
    const worktreePath = mkdtempSync(join(tmpdir(), "fleet-postmortem-wt-"));

    const md = await gatherFailurePostMortem(dataDir, project, { number: 7 }, record({ worktreePath }), baseOpts);

    expect(worktreeMod.collectBranchSummary).toHaveBeenCalledWith(project, worktreePath);
    expect(md).toContain("**Work in progress**");
    expect(md).toContain("abc123 fix the thing");
  });

  it("never throws and still returns a usable comment when there is no ticket record at all", async () => {
    const dataDir = makeDataDir();

    const md = await gatherFailurePostMortem(dataDir, project, { number: 99 }, undefined, baseOpts);

    expect(md).toContain("**Error**");
    expect(md).toContain(baseOpts.error);
    expect(md).toContain("**Next steps**");
  });
});
