import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptPlan,
  connectBoardSocket,
  fetchApprovals,
  fetchBoard,
  fetchTicket,
  fetchTicketReport,
  resolveApproval,
  restartTicket,
  sendReply,
  setDaemonPaused,
  setProjectDormant,
  setProjectPaused,
  setTicketPriority,
} from "./api.ts";

function mockFetch(status: number, body: unknown, url = "http://localhost/api/x") {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    url,
    json: () => Promise.resolve(body),
  } as Response);
}

describe("json() error handling (via fetchBoard)", () => {
  it("throws the server-provided error message on a non-ok response", async () => {
    vi.stubGlobal("fetch", mockFetch(400, { error: "bad request" }));
    await expect(fetchBoard()).rejects.toThrow("bad request");
    vi.unstubAllGlobals();
  });

  it("falls back to '<url> failed: <status>' when the error body has no error field", async () => {
    vi.stubGlobal("fetch", mockFetch(500, {}, "http://localhost/api/board"));
    await expect(fetchBoard()).rejects.toThrow("http://localhost/api/board failed: 500");
    vi.unstubAllGlobals();
  });

  it("falls back to '<url> failed: <status>' when the error body isn't valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        url: "http://localhost/api/board",
        json: () => Promise.reject(new Error("not json")),
      } as Response),
    );
    await expect(fetchBoard()).rejects.toThrow("http://localhost/api/board failed: 502");
    vi.unstubAllGlobals();
  });

  it("resolves with the parsed body on an ok response", async () => {
    const board = { tickets: [], updatedAt: "now", paused: false, runningCount: 0 };
    vi.stubGlobal("fetch", mockFetch(200, board));
    await expect(fetchBoard()).resolves.toEqual(board);
    vi.unstubAllGlobals();
  });
});

describe("API functions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchBoard sends GET /api/board", async () => {
    const fetchMock = mockFetch(200, { tickets: [], updatedAt: "now", paused: false, runningCount: 0 });
    vi.stubGlobal("fetch", fetchMock);
    await fetchBoard();
    expect(fetchMock).toHaveBeenCalledWith("/api/board");
  });

  it("fetchTicket sends GET /api/tickets/:project/:issue, URL-encoding the project", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await fetchTicket("owner/repo", 44);
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/owner%2Frepo/44");
  });

  it("fetchTicketReport sends GET /api/tickets/:project/:issue/report, URL-encoding the project", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await fetchTicketReport("owner/repo", 44);
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/owner%2Frepo/44/report");
  });

  it("setTicketPriority POSTs the priority as JSON", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await setTicketPriority("proj", 5, "high");
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/proj/5/priority", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: "high" }),
    });
  });

  it("setTicketPriority allows clearing the priority with null", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await setTicketPriority("proj", 5, null);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tickets/proj/5/priority",
      expect.objectContaining({ body: JSON.stringify({ priority: null }) }),
    );
  });

  it("sendReply POSTs the message and defaults the mode to 'sent'", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendReply("proj", 5, "hello");
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/proj/5/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(result).toEqual({ mode: "sent" });
  });

  it("sendReply passes through a server-provided mode", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { mode: "queued" }));
    const result = await sendReply("proj", 5, "hello");
    expect(result).toEqual({ mode: "queued" });
  });

  it("restartTicket POSTs with no body", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await restartTicket("proj", 5);
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/proj/5/restart", { method: "POST" });
  });

  it("acceptPlan POSTs with no body", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await acceptPlan("proj", 5);
    expect(fetchMock).toHaveBeenCalledWith("/api/tickets/proj/5/accept-plan", { method: "POST" });
  });

  it("setDaemonPaused POSTs the paused flag as JSON", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await setDaemonPaused(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/daemon/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
  });

  it("setProjectPaused POSTs the paused flag as JSON, URL-encoding the project", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await setProjectPaused("owner/repo", true);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/owner%2Frepo/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
  });

  it("setProjectDormant POSTs the dormant flag as JSON, URL-encoding the project", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await setProjectDormant("owner/repo", true);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/owner%2Frepo/dormant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dormant: true }),
    });
  });

  it("fetchApprovals sends GET /api/approvals", async () => {
    const fetchMock = mockFetch(200, { approvals: [] });
    vi.stubGlobal("fetch", fetchMock);
    await fetchApprovals();
    expect(fetchMock).toHaveBeenCalledWith("/api/approvals");
  });

  it("resolveApproval POSTs the decision and message, URL-encoding the id", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await resolveApproval("id/with/slash", "answer", "the answer");
    expect(fetchMock).toHaveBeenCalledWith("/api/approvals/id%2Fwith%2Fslash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "answer", message: "the answer" }),
    });
  });

  it("resolveApproval omits the message when not given", async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await resolveApproval("id1", "deny");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/approvals/id1",
      expect.objectContaining({ body: JSON.stringify({ decision: "deny", message: undefined }) }),
    );
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closeCalls++;
    this.onclose?.();
  }
}

describe("connectBoardSocket", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens a socket at /ws on the current host", () => {
    connectBoardSocket(vi.fn(), vi.fn());
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toMatch(/^ws:\/\/[^/]+\/ws$/);
  });

  it("reports connected status on open", () => {
    const onStatus = vi.fn();
    connectBoardSocket(vi.fn(), onStatus);
    FakeWebSocket.instances[0]!.onopen?.();
    expect(onStatus).toHaveBeenCalledWith(true);
  });

  it("forwards the parsed message type", () => {
    const onEvent = vi.fn();
    connectBoardSocket(onEvent, vi.fn());
    FakeWebSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ type: "board-updated" }) });
    expect(onEvent).toHaveBeenCalledWith("board-updated");
  });

  it("forwards 'unknown' for unparseable messages", () => {
    const onEvent = vi.fn();
    connectBoardSocket(onEvent, vi.fn());
    FakeWebSocket.instances[0]!.onmessage?.({ data: "not json" });
    expect(onEvent).toHaveBeenCalledWith("unknown");
  });

  it("reports disconnected status and reconnects after a close", () => {
    const onStatus = vi.fn();
    connectBoardSocket(vi.fn(), onStatus);
    FakeWebSocket.instances[0]!.onclose?.();
    expect(onStatus).toHaveBeenCalledWith(false);
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(3000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("stops reconnecting once the returned cleanup function is called", () => {
    const disconnect = connectBoardSocket(vi.fn(), vi.fn());
    const first = FakeWebSocket.instances[0]!;
    disconnect();
    expect(first.closeCalls).toBe(1);

    vi.advanceTimersByTime(30000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
