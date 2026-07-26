/**
 * Rate-limits a callback to at most once per `intervalMs`, with a trailing edge:
 * a trigger arriving inside the throttle window schedules a single deferred
 * invocation at the end of the window rather than dropping it. At most one
 * trailing invocation is pending at a time (timers are never stacked).
 */
export class TrailingThrottle {
  private lastFired = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly intervalMs: number,
    private readonly fire: () => void,
  ) {}

  trigger(): void {
    const now = Date.now();
    const elapsed = now - this.lastFired;
    if (elapsed >= this.intervalMs) {
      this.lastFired = now;
      this.fire();
      return;
    }
    if (this.timer) return; // a trailing invocation is already scheduled
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.lastFired = Date.now();
      this.fire();
    }, this.intervalMs - elapsed);
    this.timer.unref?.();
  }
}
