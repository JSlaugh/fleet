import { describe, expect, it } from "vitest";
import { BASE_BACKOFF_MS, MAX_BACKOFF_MS, RESTART_EXIT_CODE, STABLE_UPTIME_MS, decideNextAction } from "./supervisor-policy.mjs";

describe("decideNextAction", () => {
  it("stops on a clean exit (0) without relaunching", () => {
    expect(decideNextAction({ code: 0, uptimeMs: 1000, backoffMs: BASE_BACKOFF_MS })).toEqual({ action: "stop" });
  });

  it("relaunches immediately on the restart exit code and resets backoff", () => {
    const result = decideNextAction({ code: RESTART_EXIT_CODE, uptimeMs: 1000, backoffMs: 160_000 });
    expect(result).toEqual({ action: "relaunch", delayMs: 0, nextBackoffMs: BASE_BACKOFF_MS });
  });

  it("relaunches a crash after the current backoff and doubles it", () => {
    const result = decideNextAction({ code: 1, uptimeMs: 1000, backoffMs: BASE_BACKOFF_MS });
    expect(result).toEqual({ action: "relaunch", delayMs: BASE_BACKOFF_MS, nextBackoffMs: BASE_BACKOFF_MS * 2 });
  });

  it("doubles repeatedly across consecutive fast crashes up to the cap", () => {
    let backoffMs = BASE_BACKOFF_MS;
    const delays = [];
    for (let i = 0; i < 8; i++) {
      const result = decideNextAction({ code: 1, uptimeMs: 500, backoffMs });
      delays.push(result.delayMs);
      backoffMs = result.nextBackoffMs;
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  it("resets backoff to the base once the daemon stays up past the stable-uptime threshold", () => {
    const result = decideNextAction({ code: 1, uptimeMs: STABLE_UPTIME_MS + 1, backoffMs: 300_000 });
    expect(result).toEqual({ action: "relaunch", delayMs: BASE_BACKOFF_MS, nextBackoffMs: BASE_BACKOFF_MS * 2 });
  });

  it("treats any nonzero, non-restart code as a crash the same way", () => {
    const a = decideNextAction({ code: 1, uptimeMs: 1000, backoffMs: BASE_BACKOFF_MS });
    const b = decideNextAction({ code: 137, uptimeMs: 1000, backoffMs: BASE_BACKOFF_MS });
    expect(a).toEqual(b);
  });
});
