import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "./approvals.ts";

function baseReq(mgr: ApprovalManager, extra: Partial<Parameters<ApprovalManager["request"]>[0]> = {}) {
  return mgr.request({
    project: "proj",
    issueNumber: 7,
    toolName: "Bash",
    kind: "permission",
    input: { command: "ls" },
    timeoutMs: 60_000,
    ...extra,
  });
}

describe("ApprovalManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists a pending request and clears it once resolved (allow)", async () => {
    const mgr = new ApprovalManager();
    const promise = baseReq(mgr);
    expect(mgr.list()).toHaveLength(1);
    const id = mgr.list()[0]!.id;

    expect(mgr.resolve(id, { allowed: true })).toBe(true);
    await expect(promise).resolves.toEqual({ allowed: true, reason: "allowed" });
    expect(mgr.list()).toHaveLength(0);
  });

  it("settles with deny", async () => {
    const mgr = new ApprovalManager();
    const promise = baseReq(mgr);
    const id = mgr.list()[0]!.id;
    mgr.resolve(id, { allowed: false });
    await expect(promise).resolves.toEqual({ allowed: false, reason: "denied" });
  });

  it("settles an answer (message) outcome", async () => {
    const mgr = new ApprovalManager();
    const promise = baseReq(mgr, { kind: "question" });
    const id = mgr.list()[0]!.id;
    mgr.resolve(id, { allowed: true, message: "use option A" });
    await expect(promise).resolves.toEqual({ allowed: true, message: "use option A", reason: "answered" });
    expect(mgr.list()).toHaveLength(0);
  });

  it("denies on timeout", async () => {
    vi.useFakeTimers();
    const mgr = new ApprovalManager();
    const promise = baseReq(mgr, { timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toEqual({ allowed: false, reason: "timed out" });
    expect(mgr.list()).toHaveLength(0);
  });

  it("denies when the AbortSignal aborts", async () => {
    const mgr = new ApprovalManager();
    const controller = new AbortController();
    const promise = baseReq(mgr, { signal: controller.signal });
    controller.abort();
    await expect(promise).resolves.toEqual({ allowed: false, reason: "session aborted" });
    expect(mgr.list()).toHaveLength(0);
  });

  it("removes the abort listener once resolved normally", async () => {
    const mgr = new ApprovalManager();
    const controller = new AbortController();
    const promise = baseReq(mgr, { signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    const id = mgr.list()[0]!.id;
    mgr.resolve(id, { allowed: true });
    await promise;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("removes the abort listener when it times out", async () => {
    vi.useFakeTimers();
    const mgr = new ApprovalManager();
    const controller = new AbortController();
    const promise = baseReq(mgr, { timeoutMs: 1000, signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    await promise;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("double-resolve returns false the second time", async () => {
    const mgr = new ApprovalManager();
    const promise = baseReq(mgr);
    const id = mgr.list()[0]!.id;
    expect(mgr.resolve(id, { allowed: true })).toBe(true);
    expect(mgr.resolve(id, { allowed: false })).toBe(false);
    await expect(promise).resolves.toEqual({ allowed: true, reason: "allowed" });
  });

  it("emits events on request and on settle", async () => {
    const mgr = new ApprovalManager();
    let count = 0;
    mgr.events.on("approvals", () => count++);
    const promise = baseReq(mgr);
    expect(count).toBe(1); // request
    const id = mgr.list()[0]!.id;
    mgr.resolve(id, { allowed: true });
    expect(count).toBe(2); // settle
    await promise;
  });
});
