import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCtx, makeFleetConfig } from "../test-support.ts";
import { AUTH_PROBE_CACHE_MS, checkAuthGate, invalidateAuthProbeCache, isProbeCacheFresh } from "./authGate.ts";
import { closeAllDatabases } from "../store/db.ts";
import { StateStore } from "../store/state.ts";

vi.mock("../session/review.ts", () => ({
  runAuthProbe: vi.fn(async () => ({ healthy: true })),
}));

const review = await import("../session/review.ts");

const dataDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-authgate-"));
  dataDirs.push(dir);
  return dir;
}

afterEach(() => {
  closeAllDatabases();
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(review.runAuthProbe).mockResolvedValue({ healthy: true });
});

function ctxWith(state: StateStore) {
  return makeCtx({ config: makeFleetConfig(), state });
}

describe("isProbeCacheFresh", () => {
  it("is stale when there is no cache yet", () => {
    expect(isProbeCacheFresh(undefined, Date.now())).toBe(false);
  });

  it("is fresh just under the cache window", () => {
    const now = Date.now();
    expect(isProbeCacheFresh({ checkedAt: now - (AUTH_PROBE_CACHE_MS - 1) }, now)).toBe(true);
  });

  it("is stale once the cache window has fully elapsed", () => {
    const now = Date.now();
    expect(isProbeCacheFresh({ checkedAt: now - AUTH_PROBE_CACHE_MS }, now)).toBe(false);
  });
});

describe("checkAuthGate", () => {
  it("releases the gate on a healthy probe", async () => {
    const state = new StateStore(tempDataDir());
    const ctx = ctxWith(state);

    const held = await checkAuthGate(ctx);

    expect(held).toBe(false);
    expect(ctx.authGateHeld).toBe(false);
    expect(state.getEventsSince(new Date(0).toISOString())).toEqual([]);
  });

  it("holds the gate and records one gate-hold-auth-probe event on an unhealthy probe", async () => {
    vi.mocked(review.runAuthProbe).mockResolvedValue({ healthy: false });
    const state = new StateStore(tempDataDir());
    const ctx = ctxWith(state);

    const held = await checkAuthGate(ctx);

    expect(held).toBe(true);
    expect(ctx.authGateHeld).toBe(true);
    const events = state.getEventsSince(new Date(0).toISOString());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "gate-hold-auth-probe" });
  });

  it("logs and records the hold once per spell, not once per cycle — dedup matches the budget-gate pattern", async () => {
    vi.mocked(review.runAuthProbe).mockResolvedValue({ healthy: false });
    const state = new StateStore(tempDataDir());
    const ctx = ctxWith(state);
    // Force a fresh probe every call so the dedup under test is the event/log
    // dedup, not the cache — a real spell can span many cycles.
    ctx.authProbeCache = undefined;

    await checkAuthGate(ctx);
    ctx.authProbeCache = undefined;
    await checkAuthGate(ctx);
    ctx.authProbeCache = undefined;
    await checkAuthGate(ctx);

    expect(state.getEventsSince(new Date(0).toISOString())).toHaveLength(1);
  });

  it("re-notifies on a later spell once the gate has released in between", async () => {
    const state = new StateStore(tempDataDir());
    const ctx = ctxWith(state);

    vi.mocked(review.runAuthProbe).mockResolvedValue({ healthy: false });
    await checkAuthGate(ctx);

    ctx.authProbeCache = undefined;
    vi.mocked(review.runAuthProbe).mockResolvedValue({ healthy: true });
    expect(await checkAuthGate(ctx)).toBe(false);

    ctx.authProbeCache = undefined;
    vi.mocked(review.runAuthProbe).mockResolvedValue({ healthy: false });
    await checkAuthGate(ctx);

    const events = state.getEventsSince(new Date(0).toISOString());
    expect(events.filter((e) => e.type === "gate-hold-auth-probe")).toHaveLength(2);
  });

  it("does not re-probe while the cached result is still fresh", async () => {
    const state = new StateStore(tempDataDir());
    const ctx = ctxWith(state);

    await checkAuthGate(ctx);
    await checkAuthGate(ctx);
    await checkAuthGate(ctx);

    expect(review.runAuthProbe).toHaveBeenCalledOnce();
  });

  it("re-probes once the cache has gone stale", async () => {
    const state = new StateStore(tempDataDir());
    const ctx = ctxWith(state);
    ctx.authProbeCache = { healthy: true, checkedAt: Date.now() - AUTH_PROBE_CACHE_MS - 1 };

    await checkAuthGate(ctx);

    expect(review.runAuthProbe).toHaveBeenCalledOnce();
  });

  it("passes the first project's light/model config and the daemon's claudeExecutable to the probe", async () => {
    const state = new StateStore(tempDataDir());
    const config = makeFleetConfig({
      claudeExecutable: "/opt/claude",
      projects: [{ ...makeFleetConfig().projects[0]!, name: "alpha", model: "claude-sonnet-5", lightModel: "claude-haiku-4-5" }],
    });
    const ctx = makeCtx({ config, state });

    await checkAuthGate(ctx);

    expect(review.runAuthProbe).toHaveBeenCalledWith({ model: "claude-haiku-4-5", claudeExecutable: "/opt/claude" });
  });
});

describe("invalidateAuthProbeCache", () => {
  it("clears the cached probe result so the next checkAuthGate re-probes", async () => {
    const state = new StateStore(tempDataDir());
    const ctx = ctxWith(state);

    await checkAuthGate(ctx);
    expect(ctx.authProbeCache).toBeDefined();

    invalidateAuthProbeCache(ctx);
    expect(ctx.authProbeCache).toBeUndefined();

    await checkAuthGate(ctx);
    expect(review.runAuthProbe).toHaveBeenCalledTimes(2);
  });
});
