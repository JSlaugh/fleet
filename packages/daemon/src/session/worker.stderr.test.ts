import { describe, expect, it } from "vitest";
import { StderrCapture } from "./worker.ts";

describe("StderrCapture", () => {
  it("accumulates appended chunks in order", () => {
    const capture = new StderrCapture();

    capture.append("first line\n");
    capture.append("second line\n");

    expect(capture.take()).toBe("first line\nsecond line");
  });

  it("keeps only the newest output once the limit is exceeded", () => {
    const capture = new StderrCapture(10);

    capture.append("0123456789");
    capture.append("ABCDE");

    expect(capture.take()).toBe("56789ABCDE");
  });

  it("drains on take so the same output is never reported twice", () => {
    const capture = new StderrCapture();
    capture.append("boom");

    const first = capture.take();

    expect(first).toBe("boom");
    expect(capture.take()).toBe("");
  });

  it("returns empty for whitespace-only output", () => {
    const capture = new StderrCapture();

    capture.append("  \n\n  ");

    expect(capture.take()).toBe("");
  });
});
