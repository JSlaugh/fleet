import { describe, expect, it } from "vitest";
import { buildFileTicketRequest, formatBacklogText, formatBoardStatusText, priorityLabel, summarizeBoard } from "./client.ts";

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
