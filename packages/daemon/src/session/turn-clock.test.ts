import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnClock } from "./turn-clock.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TurnClock", () => {
  it("calls onExpire once the configured duration elapses", () => {
    const clock = new TurnClock();
    const onExpire = vi.fn();
    clock.start(1000, onExpire);

    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("freezes the remaining time while paused, however long the pause lasts", () => {
    const clock = new TurnClock();
    const onExpire = vi.fn();
    clock.start(1000, onExpire);

    vi.advanceTimersByTime(400);
    clock.pause();
    vi.advanceTimersByTime(10 * 60_000); // an approval left pending far past the budget
    expect(onExpire).not.toHaveBeenCalled();

    clock.resume();
    vi.advanceTimersByTime(599);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("does not resume until every overlapping pause has also been released", () => {
    const clock = new TurnClock();
    const onExpire = vi.fn();
    clock.start(1000, onExpire);

    vi.advanceTimersByTime(200);
    clock.pause();
    clock.pause();
    vi.advanceTimersByTime(5000);
    clock.resume();
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled(); // still one pause outstanding

    clock.resume();
    vi.advanceTimersByTime(799);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("stop cancels the countdown and leaves the clock inert", () => {
    const clock = new TurnClock();
    const onExpire = vi.fn();
    clock.start(1000, onExpire);

    vi.advanceTimersByTime(200);
    clock.stop();
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("a resume with no matching pause is a harmless no-op", () => {
    const clock = new TurnClock();
    const onExpire = vi.fn();
    clock.start(1000, onExpire);

    clock.resume();
    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("pausing after the clock already expired does not throw or resurrect the callback", () => {
    const clock = new TurnClock();
    const onExpire = vi.fn();
    clock.start(1000, onExpire);

    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledOnce();

    clock.pause();
    clock.resume();
    vi.advanceTimersByTime(10_000);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("a pause taken before start holds: the full budget only starts counting at the last resume", () => {
    const clock = new TurnClock();
    const onExpire = vi.fn();
    clock.pause();
    clock.start(1000, onExpire);

    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    clock.resume();
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("an approval spanning a turn boundary keeps the next turn frozen, and its resume releases only its own pause", () => {
    const clock = new TurnClock();
    const turn1 = vi.fn();
    const turn2 = vi.fn();
    clock.start(1000, turn1);
    clock.pause(); // approval A, requested during turn 1
    clock.stop(); // turn 1 ends while A is still pending

    clock.start(1000, turn2);
    clock.pause(); // approval B, in turn 2
    clock.resume(); // A settles — B still pending, so the clock must stay frozen
    vi.advanceTimersByTime(60_000);
    expect(turn2).not.toHaveBeenCalled();

    clock.resume(); // B settles
    vi.advanceTimersByTime(1000);
    expect(turn2).toHaveBeenCalledOnce();
    expect(turn1).not.toHaveBeenCalled();
  });

  it("start replaces a still-running countdown rather than stacking timers", () => {
    const clock = new TurnClock();
    const first = vi.fn();
    const second = vi.fn();
    clock.start(1000, first);
    vi.advanceTimersByTime(500);
    clock.start(1000, second);

    vi.advanceTimersByTime(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
