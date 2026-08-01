import { flushPromises, mount } from "@vue/test-utils";
import type { BoardTicket, TicketDetail as TicketDetailType, TicketReport } from "@fleet/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import TicketDetail from "./TicketDetail.vue";

function makeTicket(): BoardTicket {
  return {
    project: "owner/repo",
    issueNumber: 7,
    title: "Some ticket",
    url: "https://github.com/owner/repo/issues/7",
    status: "in-progress",
    priority: null,
    isPlan: false,
  };
}

function makeDetail(): TicketDetailType {
  return { journal: [], canRestart: false, canReply: false };
}

function stubFetch(detail: TicketDetailType, report: TicketReport) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body = String(url).endsWith("/report") ? report : detail;
      return Promise.resolve({ ok: true, status: 200, url: String(url), json: () => Promise.resolve(body) } as Response);
    }),
  );
}

describe("TicketDetail operation report panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the empty state when the report has no tool calls or segments", async () => {
    stubFetch(makeDetail(), {
      toolCounts: {},
      toolErrorCounts: {},
      errorCount: 0,
      segments: [],
      totals: { toolCalls: 0, errors: 0, turns: 0, durationMs: 0, costUsd: 0 },
    });
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    expect(wrapper.text()).toContain("Operation report");
    expect(wrapper.text()).toContain("No session activity recorded yet.");
    expect(wrapper.find("table").exists()).toBe(false);
  });

  it("renders tool counts, totals, and per-segment timeline for a populated report", async () => {
    stubFetch(makeDetail(), {
      toolCounts: { Bash: 3, Read: 1 },
      toolErrorCounts: { Bash: 1 },
      errorCount: 1,
      segments: [
        { numTurns: 4, durationMs: 15000, costUsd: 0.2 },
        { numTurns: 2, durationMs: 5000, costUsd: 0.3 },
      ],
      totals: { toolCalls: 4, errors: 1, turns: 6, durationMs: 20000, costUsd: 0.5 },
    });
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    const text = wrapper.text();

    const rows = wrapper.findAll("table tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("Bash");
    expect(rows[0]!.text()).toContain("3");
    expect(rows[0]!.text()).toContain("1");

    expect(text).toContain("Segment 1");
    expect(text).toContain("Segment 2");
    expect(text).toContain("15s");
    expect(text).toContain("20s");
    expect(text).toContain("$0.50");
  });
});
