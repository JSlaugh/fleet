import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useApprovalsStore } from "./approvals.ts";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    url: "http://localhost/api/x",
    json: () => Promise.resolve(body),
  } as Response);
}

const APPROVAL = { id: "a1", project: "alpha", issueNumber: 1 };

describe("approvals store", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it("refresh applies the approvals list and clears the error", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { approvals: [APPROVAL] }));
    const store = useApprovalsStore();
    store.approvalsError = "stale";

    await store.refresh();

    expect(store.approvals).toHaveLength(1);
    expect(store.approvalsError).toBeUndefined();
  });

  it("refresh records the error and keeps the list on failure", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { approvals: [APPROVAL] }));
    const store = useApprovalsStore();
    await store.refresh();

    vi.stubGlobal("fetch", mockFetch(503, { error: "unavailable" }));
    await store.refresh();

    expect(store.approvals).toHaveLength(1);
    expect(store.approvalsError).toBe("unavailable");
  });

  it("resolve POSTs the decision, refreshes, and reports success", async () => {
    const fetchMock = mockFetch(200, { approvals: [] });
    vi.stubGlobal("fetch", fetchMock);
    const store = useApprovalsStore();
    const done = vi.fn();

    await store.resolve("a1", "allow", undefined, done);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/approvals/a1",
      expect.objectContaining({ method: "POST" }),
    );
    expect(done).toHaveBeenCalledWith(true);
  });

  it("resolve reports failure through done(false)", async () => {
    vi.stubGlobal("fetch", mockFetch(500, { error: "denied" }));
    const store = useApprovalsStore();
    const done = vi.fn();

    await store.resolve("a1", "deny", undefined, done);

    expect(done).toHaveBeenCalledWith(false);
  });
});
