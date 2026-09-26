/**
 * A pausable countdown timer: `start` arms it for a duration, and `pause`/`resume`
 * freeze/thaw the remaining time instead of stopping the countdown outright.
 * Reference-counted so overlapping pauses (e.g. two approvals requested by
 * parallel tool calls in the same turn) only resume once every pause that was
 * taken has also been released.
 *
 * The count deliberately survives `start`/`stop`: the SDK can park an approval
 * while no turn is being awaited (e.g. a steered follow-up turn running while
 * the supervisor is in the machine-review gate), and that pause must still hold
 * when the next turn arms the clock — and its eventual `resume` must release
 * *its* pause, not someone else's. Every pause is paired with a resume in a
 * `finally`, and every approval settles (timeout, answer, or session abort),
 * so the count stays balanced without resets.
 *
 * Paused time is capped per turn (`maxPausedMs`, from `approvalPauseCapMinutes`):
 * once a turn has spent that long frozen, the countdown runs again even under
 * an outstanding pause, so a worker that keeps asking for approvals can't hold
 * its slot for an unbounded multiple of `approvalTimeoutMinutes`.
 */
export class TurnClock {
  private remainingMs = 0;
  private expireCallback?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private armedAt?: number;
  private pauseCount = 0;
  private maxPausedMs = Number.POSITIVE_INFINITY;
  /** Frozen time already spent this turn, excluding the current freeze. */
  private pausedMs = 0;
  /** When the current freeze began — set only while a pause is actually freezing an armed turn. */
  private pausedSince?: number;
  private capTimer?: ReturnType<typeof setTimeout>;
  /** This turn's pause allowance is used up: pauses no longer freeze the countdown. */
  private capped = false;

  /**
   * Arms the clock for `ms`, replacing anything already running, with a fresh
   * per-turn pause allowance of `maxPausedMs`. Under an outstanding pause the
   * countdown starts only once the last pause is released (or the allowance
   * runs out).
   */
  start(ms: number, onExpire: () => void, maxPausedMs = Number.POSITIVE_INFINITY): void {
    this.clearTimer();
    this.clearCapTimer();
    this.remainingMs = ms;
    this.expireCallback = onExpire;
    this.maxPausedMs = maxPausedMs;
    this.pausedMs = 0;
    this.capped = false;
    this.pausedSince = undefined;
    if (this.pauseCount > 0) this.beginFreeze();
    else this.arm();
  }

  /** Freezes the remaining time. A second overlapping `pause()` just bumps the refcount — the clock only actually freezes once. */
  pause(): void {
    this.pauseCount++;
    if (this.pauseCount > 1 || this.capped) return;
    this.freeze();
    if (this.expireCallback) this.beginFreeze();
  }

  /** Releases one `pause()`. Only re-arms the timer once every outstanding pause has been released. */
  resume(): void {
    if (this.pauseCount === 0) return;
    this.pauseCount--;
    if (this.pauseCount > 0 || this.capped) return;
    this.endFreeze();
    this.arm();
  }

  /** Cancels the countdown and forgets the callback — safe to call whether or not the clock is currently paused (outstanding pauses still hold for the next `start`). */
  stop(): void {
    this.clearTimer();
    this.clearCapTimer();
    this.pausedSince = undefined;
    this.expireCallback = undefined;
  }

  private arm(): void {
    if (!this.expireCallback || (this.pauseCount > 0 && !this.capped)) return;
    this.armedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const callback = this.expireCallback;
      this.expireCallback = undefined;
      this.clearCapTimer();
      callback?.();
    }, this.remainingMs);
  }

  private freeze(): void {
    if (this.timer === undefined || this.armedAt === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.armedAt));
    this.armedAt = undefined;
  }

  /** Starts accounting a freeze against this turn's allowance, and schedules the point where it runs out. */
  private beginFreeze(): void {
    this.pausedSince = Date.now();
    const allowance = this.maxPausedMs - this.pausedMs;
    if (!Number.isFinite(allowance)) return;
    if (allowance <= 0) {
      this.exhaust();
      return;
    }
    this.capTimer = setTimeout(() => this.exhaust(), allowance);
  }

  private endFreeze(): void {
    this.clearCapTimer();
    if (this.pausedSince !== undefined) this.pausedMs += Date.now() - this.pausedSince;
    this.pausedSince = undefined;
  }

  private exhaust(): void {
    this.capTimer = undefined;
    this.capped = true;
    this.pausedSince = undefined;
    this.pausedMs = this.maxPausedMs;
    this.arm();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.armedAt = undefined;
  }

  private clearCapTimer(): void {
    if (this.capTimer !== undefined) clearTimeout(this.capTimer);
    this.capTimer = undefined;
  }
}
