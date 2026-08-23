import { flushPromises, mount } from "@vue/test-utils";
import type { BoardTicket, TicketDetail as TicketDetailType, TicketTranscript } from "@fleet/shared";
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
    type: null,
    isPlan: false,
  };
}

function stubFetch(detail: TicketDetailType, transcript?: TicketTranscript) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).endsWith("/transcript")) {
        return transcript
          ? Promise.resolve({
              ok: true,
              status: 200,
              url: String(url),
              json: () => Promise.resolve(transcript),
            } as Response)
          : Promise.resolve({
              ok: false,
              status: 404,
              url: String(url),
              json: () => Promise.resolve({ error: "no archived transcript for this ticket" }),
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
      return Promise.resolve({ ok: true, status: 200, url: String(url), json: () => Promise.resolve(detail) } as Response);
    }),
  );
}

describe("TicketDetail archived transcript + resume command", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renames the journal heading to Session activity", async () => {
    stubFetch({ journal: [], canRestart: false, canReply: false });
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    expect(wrapper.text()).toContain("Session activity");
    expect(wrapper.text()).not.toContain("Session transcript");
  });

  it("shows the empty state when no transcript has been archived yet", async () => {
    stubFetch({ journal: [], canRestart: false, canReply: false });
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    expect(wrapper.text()).toContain("Archived transcript");
    expect(wrapper.text()).toContain("No archived transcript yet");
  });

  it("renders each archived session file for a done ticket", async () => {
    stubFetch(
      { journal: [], canRestart: false, canReply: false, record: { sessionId: "sess-abc" } as never },
      { files: [{ name: "sess-abc.jsonl", content: '{"type":"user"}\n' }] },
    );
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    expect(wrapper.text()).toContain("sess-abc.jsonl");
    expect(wrapper.text()).toContain('{"type":"user"}');
  });

  it("shows the resume command for a live ticket with a sessionId even though nothing is archived", async () => {
    stubFetch({ journal: [], canRestart: false, canReply: false, record: { sessionId: "sess-live" } as never });
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    expect(wrapper.text()).toContain("claude --resume sess-live");
    expect(wrapper.text()).toContain("No archived transcript yet");
  });

  it("omits the resume command when the ticket has no sessionId", async () => {
    stubFetch({ journal: [], canRestart: false, canReply: false });
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await flushPromises();

    expect(wrapper.text()).not.toContain("claude --resume");
  });

  it("fetches the transcript once, not on every poll tick", async () => {
    vi.useFakeTimers();
    stubFetch(
      { journal: [], canRestart: false, canReply: false, record: { sessionId: "sess-abc" } as never },
      { files: [{ name: "sess-abc.jsonl", content: '{"type":"user"}\n' }] },
    );
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await vi.advanceTimersByTimeAsync(0);
    const transcriptCalls = () =>
      vi.mocked(globalThis.fetch).mock.calls.filter((c) => String(c[0]).endsWith("/transcript")).length;
    expect(transcriptCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(transcriptCalls()).toBe(1);
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("retries a missing transcript only when the record's state moves", async () => {
    vi.useFakeTimers();
    stubFetch({
      journal: [],
      canRestart: false,
      canReply: false,
      record: { status: "running", lastActivityAt: "t1" } as never,
    });
    const wrapper = mount(TicketDetail, { props: { ticket: makeTicket() } });
    await vi.advanceTimersByTimeAsync(0);
    const transcriptCalls = () =>
      vi.mocked(globalThis.fetch).mock.calls.filter((c) => String(c[0]).endsWith("/transcript")).length;
    // Mount attempt (keyed off empty detail), then one retry once the detail's state is known.
    await vi.advanceTimersByTimeAsync(3000);
    const afterStateMove = transcriptCalls();

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(transcriptCalls()).toBe(afterStateMove);
    wrapper.unmount();
    vi.useRealTimers();
  });
});
