import { afterEach, describe, expect, it, vi } from "vitest";
import { TrailingThrottle } from "./throttle.ts";

describe("TrailingThrottle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires immediately on the leading edge", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const t = new TrailingThrottle(1000, fire);
    t.trigger();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("defers an event fired inside the window to the trailing edge (not dropped)", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const t = new TrailingThrottle(1000, fire);

    t.trigger(); // leading edge → fires now
    expect(fire).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(400);
    t.trigger(); // inside window → scheduled, not fired yet
    expect(fire).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(600); // reach end of the 1s window
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst into a single trailing emit (one pending timer max)", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const t = new TrailingThrottle(1000, fire);

    t.trigger(); // leading
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(50);
      t.trigger(); // all inside the window
    }
    expect(fire).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(2); // exactly one trailing emit for the burst
  });

  it("enforces the ~1s max rate across triggers", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const t = new TrailingThrottle(1000, fire);

    t.trigger();
    expect(fire).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    t.trigger(); // full window elapsed → leading edge again
    expect(fire).toHaveBeenCalledTimes(2);
  });
});
