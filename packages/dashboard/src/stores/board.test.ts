import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useBoardStore } from "./board.ts";

const BOARD = {
  tickets: [{ project: "alpha", issueNumber: 1, title: "t", url: "u", status: "ready", priority: null, type: null, isPlan: false }],
  updatedAt: "now",
  paused: true,
  pausedProjects: ["alpha"],
  dormantProjects: ["beta"],
  runningCount: 2,
};

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    url: "http://localhost/api/x",
    json: () => Promise.resolve(body),
  } as Response);
}

describe("board store", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it("refresh applies the board response and clears the error", async () => {
    vi.stubGlobal("fetch", mockFetch(200, BOARD));
    const store = useBoardStore();
    store.error = "stale";

    await store.refresh();

    expect(store.tickets).toHaveLength(1);
    expect(store.paused).toBe(true);
    expect(store.pausedProjects).toEqual(["alpha"]);
    expect(store.dormantProjects).toEqual(["beta"]);
    expect(store.runningCount).toBe(2);
    expect(store.error).toBeUndefined();
  });

  it("refresh keeps existing data and records the error on a failed fetch", async () => {
    vi.stubGlobal("fetch", mockFetch(200, BOARD));
    const store = useBoardStore();
    await store.refresh();

    vi.stubGlobal("fetch", mockFetch(500, { error: "boom" }));
    await store.refresh();

    expect(store.tickets).toHaveLength(1);
    expect(store.error).toBe("boom");
  });

  it("togglePaused POSTs the flipped flag and refreshes", async () => {
    const fetchMock = mockFetch(200, BOARD);
    vi.stubGlobal("fetch", fetchMock);
    const store = useBoardStore();

    await store.togglePaused();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/daemon/pause",
      expect.objectContaining({ body: JSON.stringify({ paused: true }) }),
    );
    expect(store.pauseToggling).toBe(false);
    expect(store.paused).toBe(true);
  });

  it("setPriority failure clears the busy path without touching store.error", async () => {
    vi.stubGlobal("fetch", mockFetch(500, { error: "nope" }));
    const store = useBoardStore();

    await store.setPriority(BOARD.tickets[0]! as never, "fleet:p1");

    expect(store.error).toBeUndefined();
  });

  it("toggleProjectPaused tracks the busy project while in flight", async () => {
    vi.stubGlobal("fetch", mockFetch(200, BOARD));
    const store = useBoardStore();

    const pending = store.toggleProjectPaused("alpha");
    expect(store.projectPauseToggling).toBe("alpha");
    await pending;

    expect(store.projectPauseToggling).toBeUndefined();
  });
});
