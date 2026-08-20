import { flushPromises, mount } from "@vue/test-utils";
import type { BoardTicket, TicketDetail as TicketDetailType, TicketDiff } from "@fleet/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import TicketDetail from "./TicketDetail.vue";

function makeTicket(): BoardTicket {
  return {
    project: "owner/repo",
    issueNumber: 7,
    title: "Some ticket",
    url: "https://github.com/owner/repo/issues/7",
    status: "review",
    priority: null,
    isPlan: false,
  };
}

function stubFetch(detail: TicketDetailType, diff?: TicketDiff) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).endsWith("/diff")) {
        return diff
          ? Promise.resolve({ ok: true, status: 200, url: String(url), json: () => Promise.resolve(diff) } as Response)
          : Promise.resolve({
              ok: false,
              status: 404,
              url: String(url),
              json: () => Promise.resolve({ error: "no PR for this ticket" }),
            } as Response);
      }
      if (String(url).endsWith("/report")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          url: String(url),
          json: () =>
            Promise.resolve({
              toolCounts: {},
              toolErrorCounts: {},
              errorCount: 0,
              segments: [],
              totals: { toolCalls: 0, errors: 0, turns: 0, durationMs: 0, costUsd: 0 },
            }),
        } as Response);
      }
      if (String(url).endsWith("/transcript")) {
        return Promise.resolve({
          ok: false,
          status: 404,
          url: String(url),
          json: () => Promise.resolve({ error: "no archived transcript for this ticket" }),
        } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, url: String(url), json: () => Promise.resolve(detail) } as Response);
    }),
  );
}

function stubOtherEndpoints(detail: () => TicketDetailType) {
  return vi.fn((url: string) => {
    if (String(url).endsWith("/report")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        url: String(url),
        json: () =>
          Promise.resolve({
            toolCounts: {},
            toolErrorCounts: {},
            errorCount: 0,
            segments: [],
            totals: { toolCalls: 0, errors: 0, turns: 0, durationMs: 0, costUsd: 0 },
          }),
      } as Response);
    }
    if (String(url).endsWith("/transcript")) {
      return Promise.resolve({
        ok: false,
        status: 404,
        url: String(url),
        json: () => Promise.resolve({ error: "no archived transcript for this ticket" }),
      } as Response);
    }
    return Promise.resolve({ ok: true, status: 200, url: String(url), json: () => Promise.resolve(detail()) } as Response);
  });
}

describe("TicketDetail diff preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows nothing for a ticket with no PR", async () => {
    stubFetch({ journal: [], canRestart: false, canReply: false });
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    expect(wrapper.text()).not.toContain("Diff");
  });

  it("renders the file list and diff lines for a ticket with an open PR", async () => {
    stubFetch(
      { journal: [], canRestart: false, canReply: false, record: { prUrl: "https://github.com/owner/repo/pull/7" } as never },
      {
        prUrl: "https://github.com/owner/repo/pull/7",
        files: [{ path: "src/foo.ts", additions: 2, deletions: 1 }],
        diff: "diff --git a/src/foo.ts b/src/foo.ts\n+added line\n-removed line\n context line",
        truncated: false,
      },
    );
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    expect(wrapper.text()).toContain("Diff");
    expect(wrapper.text()).toContain("src/foo.ts");
    expect(wrapper.text()).toContain("added line");
    expect(wrapper.text()).toContain("removed line");
    expect(wrapper.text()).not.toContain("open on GitHub");
  });

  it("shows a truncation notice with an escape hatch to GitHub for an oversized diff", async () => {
    stubFetch(
      { journal: [], canRestart: false, canReply: false, record: { prUrl: "https://github.com/owner/repo/pull/7" } as never },
      {
        prUrl: "https://github.com/owner/repo/pull/7",
        files: [{ path: "src/foo.ts", additions: 2, deletions: 1 }],
        diff: "+added line",
        truncated: true,
      },
    );
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    expect(wrapper.text()).toContain("open on GitHub");
    const link = wrapper.find('a[href="https://github.com/owner/repo/pull/7"]');
    expect(link.exists()).toBe(true);
  });

  it("shows an error instead of an endless loading state when the diff fetch fails", async () => {
    const other = stubOtherEndpoints(() => ({
      journal: [],
      canRestart: false,
      canReply: false,
      record: { prUrl: "https://github.com/owner/repo/pull/7" } as never,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).endsWith("/diff")) {
          return Promise.resolve({
            ok: false,
            status: 502,
            url: String(url),
            json: () => Promise.resolve({ error: "gh: rate limited" }),
          } as Response);
        }
        return other(url);
      }),
    );
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    expect(wrapper.text()).not.toContain("Loading diff");
    expect(wrapper.text()).toContain("gh: rate limited");
  });

  it("does not re-fetch the diff on every poll tick once it's loaded, only when lastActivityAt moves", async () => {
    vi.useFakeTimers();
    let lastActivityAt = "2026-01-01T00:00:00.000Z";
    const other = stubOtherEndpoints(() => ({
      journal: [],
      canRestart: false,
      canReply: false,
      record: { prUrl: "https://github.com/owner/repo/pull/7", lastActivityAt } as never,
    }));
    const fetchDiff = vi.fn(
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          url: "",
          json: () =>
            Promise.resolve({
              prUrl: "https://github.com/owner/repo/pull/7",
              files: [],
              diff: "+line",
              truncated: false,
            }),
        } as Response),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => (String(url).endsWith("/diff") ? fetchDiff() : other(url))),
    );

    mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();
    expect(fetchDiff).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(fetchDiff).toHaveBeenCalledTimes(1);

    lastActivityAt = "2026-01-01T00:05:00.000Z";
    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(fetchDiff).toHaveBeenCalledTimes(2);
  });
});
