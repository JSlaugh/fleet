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

  it("emits approval:requested on request and approval:settled with a reason on settle", async () => {
    const mgr = new ApprovalManager();
    let requested = 0;
    let settled: string | undefined;
    mgr.events.on("approval:requested", () => {
      requested++;
    });
    mgr.events.on("approval:settled", ({ reason }) => {
      settled = reason;
    });
    const promise = baseReq(mgr);
    expect(requested).toBe(1);
    const id = mgr.list()[0]!.id;
    mgr.resolve(id, { allowed: true });
    expect(settled).toBe("allowed");
    await promise;
  });

  it("emits approval:settled with the right reason for every way a request can settle", async () => {
    vi.useFakeTimers();
    const mgr = new ApprovalManager();
    const reasons: string[] = [];
    mgr.events.on("approval:settled", ({ approval, reason }) => {
      reasons.push(`${approval.id}:${reason}`);
    });

    const denied = baseReq(mgr);
    mgr.resolve(mgr.list()[0]!.id, { allowed: false });
    await denied;

    const answered = baseReq(mgr, { kind: "question" });
    mgr.resolve(mgr.list()[0]!.id, { allowed: true, message: "yes" });
    await answered;

    const timedOut = baseReq(mgr, { timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    await timedOut;

    const abort = new AbortController();
    const aborted = baseReq(mgr, { signal: abort.signal });
    abort.abort();
    await aborted;

    expect(reasons).toEqual(["apr-1-7:denied", "apr-2-7:answered", "apr-3-7:timed out", "apr-4-7:session aborted"]);
  });
});
