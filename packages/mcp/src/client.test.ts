import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFileTicketRequest,
  buildHistoryPath,
  fetchTicketJournal,
  fileTicket,
  formatBacklogText,
  formatBoardStatusText,
  formatDurationMs,
  formatHistoryRecordLine,
  formatHistoryText,
  formatJournalText,
  formatTicketReportText,
  priorityLabel,
  summarizeBoard,
  type HistoryAggregatesLike,
  type HistoryRecordLike,
  type TicketReportLike,
} from "./client.ts";

describe("priorityLabel", () => {
  it("maps the short priority to a fleet: label", () => {
    expect(priorityLabel("p1")).toBe("fleet:p1");
    expect(priorityLabel("p2")).toBe("fleet:p2");
    expect(priorityLabel("p3")).toBe("fleet:p3");
  });

  it("returns undefined when no priority is given", () => {
    expect(priorityLabel(undefined)).toBeUndefined();
  });
});

describe("buildFileTicketRequest", () => {
  it("builds a minimal request from just title and body", () => {
    expect(buildFileTicketRequest({ title: "t", body: "b" })).toEqual({ title: "t", body: "b" });
  });

  it("includes the mapped priority label when given", () => {
    expect(buildFileTicketRequest({ title: "t", body: "b", priority: "p1" })).toEqual({
      title: "t",
      body: "b",
      priority: "fleet:p1",
    });
  });

  it("passes ready through when explicitly set", () => {
    expect(buildFileTicketRequest({ title: "t", body: "b", ready: false })).toEqual({
      title: "t",
      body: "b",
      ready: false,
    });
  });

  it("omits ready when not given, leaving the daemon's default", () => {
    expect(buildFileTicketRequest({ title: "t", body: "b" })).not.toHaveProperty("ready");
  });

  it("includes dependsOn when given", () => {
    expect(buildFileTicketRequest({ title: "t", body: "b", dependsOn: [12, 34] })).toEqual({
      title: "t",
      body: "b",
      dependsOn: [12, 34],
    });
  });

  it("omits dependsOn when not given", () => {
    expect(buildFileTicketRequest({ title: "t", body: "b" })).not.toHaveProperty("dependsOn");
  });
});

describe("fileTicket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("URL-encodes the project name", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ number: 1, url: "https://x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fileTicket("http://localhost:4400", "org/repo", { title: "t", body: "b" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4400/api/projects/org%2Frepo/tickets",
      expect.anything(),
    );
  });
});

describe("summarizeBoard", () => {
  it("tallies tickets per column and pulls out running ones", () => {
    const summary = summarizeBoard([
      { project: "a", issueNumber: 1, title: "one", status: "ready" },
      { project: "a", issueNumber: 2, title: "two", status: "in-progress", record: { status: "running", lastActivityNote: "editing worker.ts" } },
      { project: "b", issueNumber: 3, title: "three", status: "in-progress", record: { status: "stalled" } },
    ]);
    expect(summary.counts).toEqual({ ready: 1, "in-progress": 2 });
    expect(summary.running).toEqual([{ project: "a", issueNumber: 2, title: "two", lastActivityNote: "editing worker.ts" }]);
  });
});

describe("formatBacklogText", () => {
  it("reports an empty backlog", () => {
    expect(formatBacklogText([])).toBe("Backlog is empty.");
  });

  it("formats each ticket compactly", () => {
    const text = formatBacklogText([{ number: 12, title: "Add a thing", status: "ready", priority: "fleet:p1", url: "https://x" }]);
    expect(text).toBe("#12 [ready] fleet:p1 Add a thing");
  });

  it("omits the priority segment when there is none", () => {
    const text = formatBacklogText([{ number: 12, title: "Add a thing", status: "ready", priority: null, url: "https://x" }]);
    expect(text).toBe("#12 [ready] Add a thing");
  });
});

function historyRecord(patch: Partial<HistoryRecordLike> = {}): HistoryRecordLike {
  return {
    project: "alpha",
    issueNumber: 62,
    issueTitle: "Fix retries",
    closedAt: "2026-08-20T14:00:00.000Z",
    prState: "MERGED",
    costUsd: 1.234,
    ...patch,
  };
}

function historyAggregates(patch: Partial<HistoryAggregatesLike> = {}): HistoryAggregatesLike {
  return {
    count: 1,
    totalCostUsd: 1.234,
    meanCostUsd: 1.234,
    meanDurationMs: 10 * 60 * 1000,
    prStateCounts: { MERGED: 1, CLOSED: 0, NONE: 0 },
    elevatedRate: 0,
    lightRate: 0,
    autoResumedRate: 0,
    planRate: 0,
    machineReviewOutcomeCounts: { pending: 0, passed: 0, findings: 0, skipped: 0, none: 1 },
    ...patch,
  };
}

describe("buildHistoryPath", () => {
  it("defaults the limit to 10 and omits absent filters", () => {
    expect(buildHistoryPath({})).toBe("/api/history?limit=10");
  });

  it("includes project and time filters when given", () => {
    expect(buildHistoryPath({ project: "org/repo", since: "2026-08-01", limit: 5 })).toBe(
      "/api/history?project=org%2Frepo&since=2026-08-01&limit=5",
    );
  });
});

describe("formatDurationMs", () => {
  it("picks the unit by magnitude", () => {
    expect(formatDurationMs(45_000)).toBe("45s");
    expect(formatDurationMs(12 * 60_000)).toBe("12m");
    expect(formatDurationMs(3.25 * 3_600_000)).toBe("3.3h");
  });
});

describe("formatHistoryRecordLine", () => {
  it("formats the core fields without extras", () => {
    expect(formatHistoryRecordLine(historyRecord())).toBe('alpha#62 [MERGED] $1.23 "Fix retries" closed 2026-08-20');
  });

  it("appends outcome extras when present", () => {
    const line = formatHistoryRecordLine(
      historyRecord({
        model: "claude-sonnet-5",
        timeToMergeMs: 2 * 3_600_000,
        reviewRounds: 2,
        humanPushedAfterOpen: true,
        bashDeniedCount: 1,
        machineReviewOutcome: "findings",
      }),
    );
    expect(line).toBe(
      'alpha#62 [MERGED] $1.23 sonnet-5 "Fix retries" closed 2026-08-20 · merged in 2.0h · 2 review rounds · human reworked · 1 bash denial · machine review: findings',
    );
  });

  it("marks plan epics", () => {
    expect(formatHistoryRecordLine(historyRecord({ prState: "NONE", isPlan: true }))).toContain("[NONE, plan]");
  });
});

describe("formatHistoryText", () => {
  it("reports when nothing matches", () => {
    expect(formatHistoryText({ records: [], total: 0, aggregates: historyAggregates({ count: 0 }) })).toBe(
      "No closed tickets match.",
    );
  });

  it("renders record lines followed by the aggregates block", () => {
    const text = formatHistoryText({
      records: [historyRecord()],
      total: 42,
      aggregates: historyAggregates({
        count: 42,
        totalCostUsd: 101.2,
        meanCostUsd: 2.41,
        prStateCounts: { MERGED: 30, CLOSED: 8, NONE: 4 },
        elevatedRate: 0.1,
        machineReviewOutcomeCounts: { pending: 0, passed: 20, findings: 9, skipped: 2, none: 11 },
      }),
    });

    expect(text).toContain('alpha#62 [MERGED] $1.23 "Fix retries"');
    expect(text).toContain("Aggregates over all 42 matching tickets (1 shown):");
    expect(text).toContain("PRs: 30 merged, 8 closed unmerged, 4 no PR");
    expect(text).toContain("cost: $101.20 total, $2.41 mean · mean time to close 10m");
    expect(text).toContain("rates: elevated 10%, light 0%, auto-resumed 0%, plans 0%");
    expect(text).toContain("machine review: passed 20, findings 9, skipped 2, none 11");
  });
});

function ticketReport(patch: Partial<TicketReportLike> = {}): TicketReportLike {
  return {
    toolCounts: { Bash: 30, Read: 25 },
    toolErrorCounts: { Bash: 2 },
    segments: [
      { numTurns: 12, durationMs: 5 * 60_000, costUsd: 0.8 },
      { numTurns: 20, durationMs: 8 * 60_000, costUsd: 1.01 },
    ],
    totals: { toolCalls: 55, errors: 2, turns: 32, durationMs: 13 * 60_000, costUsd: 1.81 },
    bashDeniedCount: 0,
    approvalLatency: { count: 0, totalWaitMs: 0, maxWaitMs: 0 },
    ...patch,
  };
}

describe("formatTicketReportText", () => {
  it("reports when the journal has nothing", () => {
    const text = formatTicketReportText(
      ticketReport({
        toolCounts: {},
        toolErrorCounts: {},
        segments: [],
        totals: { toolCalls: 0, errors: 0, turns: 0, durationMs: 0, costUsd: 0 },
      }),
    );
    expect(text).toContain("No journal data recorded");
  });

  it("renders totals, segments, and per-tool counts sorted by usage", () => {
    const text = formatTicketReportText(ticketReport());

    expect(text).toContain("Totals: 55 tool calls (2 errors) · 32 turns · 13m · $1.81");
    expect(text).toContain("Sessions: 2 — 12 turns/5m/$0.80, 20 turns/8m/$1.01");
    expect(text).toContain("Tools: Bash ×30 (2 errors), Read ×25");
    expect(text).not.toContain("Bash contract denials");
    expect(text).not.toContain("Approvals:");
  });

  it("includes denials, approval latency, and machine-review findings when present", () => {
    const text = formatTicketReportText(
      ticketReport({
        bashDeniedCount: 3,
        approvalLatency: { count: 2, totalWaitMs: 90_000, maxWaitMs: 50_000 },
        machineReview: {
          kind: "code",
          outcome: "findings",
          findings: [{ file: "src/x.ts", line: 42, severity: "major", summary: "off-by-one" }],
        },
      }),
    );

    expect(text).toContain("Bash contract denials: 3");
    expect(text).toContain("Approvals: 2 waited (mean 45s, max 50s)");
    expect(text).toContain("Machine review (code): findings");
    expect(text).toContain("  [major] src/x.ts:42 — off-by-one");
  });
});

describe("formatJournalText", () => {
  it("reports an empty journal", () => {
    expect(formatJournalText([])).toBe("No journal entries for this ticket.");
  });

  it("formats each entry type as a single line", () => {
    const text = formatJournalText([
      { ts: "2026-08-20T10:00:00.000Z", type: "fleet", event: "claimed" },
      { ts: "2026-08-20T10:01:00.000Z", type: "assistant", text: "Editing worker.ts\nnow", toolCalls: [{ name: "Edit" }] },
      { ts: "2026-08-20T10:02:00.000Z", type: "user", toolResults: [{ isError: true }, {}] },
      { ts: "2026-08-20T10:03:00.000Z", type: "result", subtype: "success", numTurns: 12, costUsd: 0.8 },
    ]);

    expect(text).toBe(
      [
        "2026-08-20 10:00 fleet: claimed",
        "2026-08-20 10:01 assistant: Editing worker.ts now → Edit",
        "2026-08-20 10:02 tool results ×2 (1 errors)",
        "2026-08-20 10:03 result (success) — 12 turns, $0.80",
      ].join("\n"),
    );
  });

  it("tags machine-review sub-session entries and truncates long text", () => {
    const text = formatJournalText([
      { ts: "2026-08-20T10:00:00.000Z", type: "assistant", session: "machine-review", text: "x".repeat(300) },
    ]);

    expect(text).toContain("[machine-review]");
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(260);
  });
});

describe("fetchTicketJournal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("URL-encodes the project and returns the detail's journal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ journal: [{ ts: "2026-08-20T10:00:00.000Z", type: "fleet", event: "claimed" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const journal = await fetchTicketJournal("http://localhost:4400", "org/repo", 62);

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4400/api/tickets/org%2Frepo/62", undefined);
    expect(journal).toEqual([{ ts: "2026-08-20T10:00:00.000Z", type: "fleet", event: "claimed" }]);
  });
});

describe("formatBoardStatusText", () => {
  it("reports when nothing is running", () => {
    const text = formatBoardStatusText({ counts: { ready: 1 }, running: [] });
    expect(text).toBe("ready: 1\n\nRunning:\nNone");
  });

  it("lists running tickets with their activity note", () => {
    const text = formatBoardStatusText({
      counts: { "in-progress": 1 },
      running: [{ project: "a", issueNumber: 2, title: "two", lastActivityNote: "editing worker.ts" }],
    });
    expect(text).toBe('in-progress: 1\n\nRunning:\na#2 "two" — editing worker.ts');
  });
});
