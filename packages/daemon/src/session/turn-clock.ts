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
 */
export class TurnClock {
  private remainingMs = 0;
  private expireCallback?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private armedAt?: number;
  private pauseCount = 0;

  /** Arms the clock for `ms`, replacing anything already running. Under an outstanding pause the countdown starts only once the last pause is released. */
  start(ms: number, onExpire: () => void): void {
    this.clearTimer();
    this.remainingMs = ms;
    this.expireCallback = onExpire;
    this.arm();
  }

  /** Freezes the remaining time. A second overlapping `pause()` just bumps the refcount — the clock only actually freezes once. */
  pause(): void {
    this.pauseCount++;
    if (this.pauseCount > 1) return;
    this.freeze();
  }

  /** Releases one `pause()`. Only re-arms the timer once every outstanding pause has been released. */
  resume(): void {
    if (this.pauseCount === 0) return;
    this.pauseCount--;
    if (this.pauseCount > 0) return;
    this.arm();
  }

  /** Cancels the countdown and forgets the callback — safe to call whether or not the clock is currently paused (outstanding pauses still hold for the next `start`). */
  stop(): void {
    this.clearTimer();
    this.expireCallback = undefined;
  }

  private arm(): void {
    if (!this.expireCallback || this.pauseCount > 0) return;
    this.armedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const callback = this.expireCallback;
      this.expireCallback = undefined;
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

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.armedAt = undefined;
  }
}
