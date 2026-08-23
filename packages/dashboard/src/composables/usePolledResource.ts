import { onMounted, onUnmounted } from "vue";

export interface PolledResource {
  /** Run the loader now (also what the interval calls). Superseded runs see isStale() flip true. */
  refresh: () => Promise<void>;
}

/**
 * The dashboard's polling pattern in one place: an immediate load on mount, a
 * poll timer, a stale-response guard, and cleanup on unmount.
 *
 * The loader gets an `isStale` callback because both call sites make several
 * awaits per load — the guard has to be re-checked after each one, so it can't
 * live outside the loader. A response fetched by a superseded run (a newer
 * refresh started meanwhile) must be dropped, not applied.
 *
 * `intervalMs` may be a getter, re-read after every completed load, so the
 * cadence can back off with resource state; returning null stops polling
 * until the next mount (manual refresh keeps working).
 */
export function usePolledResource(
  load: (isStale: () => boolean) => Promise<void>,
  intervalMs: number | (() => number | null),
): PolledResource {
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  async function refresh(): Promise<void> {
    const mine = ++seq;
    await load(() => mine !== seq);
  }

  function schedule() {
    if (stopped) return;
    const delay = typeof intervalMs === "function" ? intervalMs() : intervalMs;
    if (delay === null) return;
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, delay);
  }

  onMounted(() => {
    void refresh().then(schedule);
  });
  onUnmounted(() => {
    stopped = true;
    clearTimeout(timer);
  });

  return { refresh };
}
