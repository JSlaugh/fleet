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

  describe("per-turn pause cap", () => {
    it("once a turn has been frozen for maxPausedMs, the countdown runs again under the still-outstanding pause", () => {
      const clock = new TurnClock();
      const onExpire = vi.fn();
      clock.start(1000, onExpire, 5_000);
      vi.advanceTimersByTime(400);
      clock.pause(); // 600ms of budget left, frozen

      vi.advanceTimersByTime(5_000); // allowance used up — countdown resumes
      vi.advanceTimersByTime(599);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledOnce();
    });

    it("sums every pause in the turn against one allowance", () => {
      const clock = new TurnClock();
      const onExpire = vi.fn();
      clock.start(1000, onExpire, 5_000);
      clock.pause();
      vi.advanceTimersByTime(3_000);
      clock.resume(); // 3s of the 5s allowance spent, full 1000ms budget left
      clock.pause();
      vi.advanceTimersByTime(2_000); // allowance exhausted here
      vi.advanceTimersByTime(999);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledOnce();
    });

    it("gives each turn a fresh allowance", () => {
      const clock = new TurnClock();
      clock.start(1000, vi.fn(), 5_000);
      clock.pause();
      vi.advanceTimersByTime(4_000);
      clock.resume();
      clock.stop();

      const turn2 = vi.fn();
      clock.start(1000, turn2, 5_000);
      clock.pause();
      vi.advanceTimersByTime(4_999);
      expect(turn2).not.toHaveBeenCalled();
      clock.resume();
      vi.advanceTimersByTime(1000);
      expect(turn2).toHaveBeenCalledOnce();
    });

    it("a cap of 0 means approval waits always count", () => {
      const clock = new TurnClock();
      const onExpire = vi.fn();
      clock.start(1000, onExpire, 0);
      clock.pause();
      vi.advanceTimersByTime(1000);
      expect(onExpire).toHaveBeenCalledOnce();
    });

    it("a pause carried across a turn boundary counts against the new turn's allowance from its start", () => {
      const clock = new TurnClock();
      clock.start(1000, vi.fn(), 5_000);
      clock.pause();
      clock.stop();
      vi.advanceTimersByTime(60_000); // between turns: no allowance being spent

      const turn2 = vi.fn();
      clock.start(1000, turn2, 5_000);
      vi.advanceTimersByTime(5_000 + 999);
      expect(turn2).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(turn2).toHaveBeenCalledOnce();
    });
  });
});
