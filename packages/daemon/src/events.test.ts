import { describe, expect, it, vi } from "vitest";
import { FleetEvents } from "./events.ts";
import { makeProject } from "./test-support.ts";

const project = makeProject();

describe("FleetEvents", () => {
  it("delivers the payload to every subscriber of an event", () => {
    const events = new FleetEvents();
    const first = vi.fn();
    const second = vi.fn();
    events.on("board:updated", first);
    events.on("board:updated", second);

    events.emit("board:updated", {});

    expect(first).toHaveBeenCalledWith({});
    expect(second).toHaveBeenCalledWith({});
  });

  it("never calls a subscriber of a different event", () => {
    const events = new FleetEvents();
    const listener = vi.fn();
    events.on("board:updated", listener);

    events.emit("ticket:failed", { project, issueNumber: 7, title: "t", detail: "d", url: "https://example.com" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("logs and swallows a subscriber that throws synchronously, without affecting other subscribers", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = new FleetEvents();
    const after = vi.fn();
    events.on("board:updated", () => {
      throw new Error("boom");
    });
    events.on("board:updated", after);

    expect(() => events.emit("board:updated", {})).not.toThrow();

    expect(after).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.at(-1)?.[0] as string;
    expect(logged).toContain('subscriber for "board:updated" failed');
    expect(logged).toContain("boom");
    errorSpy.mockRestore();
  });

  it("logs and swallows a subscriber whose returned promise rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = new FleetEvents();
    events.on("board:updated", async () => {
      throw new Error("async boom");
    });

    events.emit("board:updated", {});
    await Promise.resolve();
    await Promise.resolve();

    const logged = errorSpy.mock.calls.at(-1)?.[0] as string;
    expect(logged).toContain('subscriber for "board:updated" failed');
    expect(logged).toContain("async boom");
    errorSpy.mockRestore();
  });

  it("flush waits for in-flight listeners (e.g. a webhook post) before resolving", async () => {
    const events = new FleetEvents();
    let finishPost!: () => void;
    let posted = false;
    events.on("ticket:pr-opened", () => new Promise<void>((resolve) => (finishPost = () => ((posted = true), resolve()))));
    events.emit("ticket:pr-opened", { project: {} as never, issueNumber: 1, title: "t", detail: "d", url: "u" });

    let flushed = false;
    const flushing = events.flush(5_000).then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false);

    finishPost();
    await flushing;
    expect(posted).toBe(true);
  });

  it("flush gives up after its timeout rather than hanging shutdown on a stuck listener", async () => {
    vi.useFakeTimers();
    try {
      const events = new FleetEvents();
      events.on("board:updated", () => new Promise<void>(() => {}));
      events.emit("board:updated", {});
      const flushing = events.flush(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(flushing).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush resolves immediately when nothing is in flight", async () => {
    await expect(new FleetEvents().flush(1_000)).resolves.toBeUndefined();
  });
});
