import { mount } from "@vue/test-utils";
import type { BoardTicket, TicketDetail as TicketDetailType } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TicketDetail from "./TicketDetail.vue";

function makeTicket(status: BoardTicket["status"]): BoardTicket {
  return {
    project: "owner/repo",
    issueNumber: 7,
    title: "Some ticket",
    url: "https://github.com/owner/repo/issues/7",
    status,
    priority: null,
    type: null,
    isPlan: false,
  };
}

function stubFetch(detail: TicketDetailType) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).endsWith("/transcript")) {
        return Promise.resolve({ ok: false, status: 404, url: String(url), json: () => Promise.resolve({}) } as Response);
      }
      if (String(url).endsWith("/report")) {
        return Promise.resolve({ ok: false, status: 404, url: String(url), json: () => Promise.resolve({}) } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, url: String(url), json: () => Promise.resolve(detail) } as Response);
    }),
  );
}

const detailCalls = () =>
  vi.mocked(globalThis.fetch).mock.calls.filter((c) => String(c[0]).endsWith("/7")).length;

describe("TicketDetail poll cadence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls a live ticket every 3s", async () => {
    stubFetch({ journal: [], canRestart: false, canReply: false });
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket("in-progress") } });
    await vi.advanceTimersByTimeAsync(0);
    expect(detailCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);

    expect(detailCalls()).toBe(2);
    wrapper.unmount();
  });

  it("backs off to 30s for a done ticket, still loading immediately on mount", async () => {
    stubFetch({ journal: [], canRestart: false, canReply: false });
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket("done") } });
    await vi.advanceTimersByTimeAsync(0);
    expect(detailCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(detailCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(27_000);
    expect(detailCalls()).toBe(2);
    wrapper.unmount();
  });
});
