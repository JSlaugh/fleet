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
});
