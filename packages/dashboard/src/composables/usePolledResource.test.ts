import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { usePolledResource, type PolledResource } from "./usePolledResource.ts";

function mountPolled(
  load: (isStale: () => boolean) => Promise<void>,
  intervalMs: number | (() => number | null),
): { polled: PolledResource; wrapper: VueWrapper } {
  let polled!: PolledResource;
  const wrapper = mount(
    defineComponent({
      setup() {
        polled = usePolledResource(load, intervalMs);
        return () => h("div");
      },
    }),
  );
  return { polled, wrapper };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("usePolledResource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads immediately on mount", async () => {
    const load = vi.fn(async () => {});

    mountPolled(load, 5000);
    await flush();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("polls on the interval after each load completes", async () => {
    const load = vi.fn(async () => {});
    mountPolled(load, 5000);
    await flush();

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);

    expect(load).toHaveBeenCalledTimes(3);
  });

  it("stops polling on unmount", async () => {
    const load = vi.fn(async () => {});
    const { wrapper } = mountPolled(load, 5000);
    await flush();

    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(20000);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("marks an in-flight load stale when a newer refresh starts", async () => {
    const staleness: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const load = vi.fn(async (isStale: () => boolean) => {
      await gate;
      staleness.push(isStale());
    });
    const { polled } = mountPolled(load, 60000);
    await flush();

    const second = polled.refresh();
    release();
    await second;
    await flush();

    // The mount-time load resolved after the manual refresh superseded it.
    expect(staleness).toEqual([true, false]);
  });

  it("re-reads a getter interval after every load, and null stops polling", async () => {
    const load = vi.fn(async () => {});
    let interval: number | null = 1000;
    mountPolled(load, () => interval);
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(2);

    interval = null;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps manual refresh working regardless of the timer", async () => {
    const load = vi.fn(async () => {});
    const { polled } = mountPolled(load, () => null);
    await flush();

    await polled.refresh();

    expect(load).toHaveBeenCalledTimes(2);
  });
});
