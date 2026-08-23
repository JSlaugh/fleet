import { describe, expect, it } from "vitest";
import { formatCost, formatDuration, formatTime, formatTokens, formatWait } from "./format.ts";

describe("formatCost", () => {
  it("returns an empty string for undefined", () => {
    expect(formatCost(undefined)).toBe("");
  });

  it("returns an empty string for zero", () => {
    expect(formatCost(0)).toBe("");
  });

  it("formats a positive cost with two decimal places and a dollar sign", () => {
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(0.004)).toBe("$0.00");
    expect(formatCost(12.345)).toBe("$12.35");
  });
});

describe("formatTime", () => {
  it("returns an empty string for undefined", () => {
    expect(formatTime(undefined)).toBe("");
  });

  it("returns a non-empty locale time string for a valid ISO timestamp", () => {
    expect(formatTime("2026-01-01T12:34:56Z")).not.toBe("");
  });
});

describe("formatDuration", () => {
  it("returns '0s' for undefined, null, and zero", () => {
    expect(formatDuration(undefined)).toBe("0s");
    expect(formatDuration(null)).toBe("0s");
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(15000)).toBe("15s");
  });

  it("formats durations over a minute as minutes and seconds", () => {
    expect(formatDuration(65000)).toBe("1m 5s");
  });
});

describe("formatWait", () => {
  it("returns 'just now' for zero or negative elapsed time", () => {
    expect(formatWait(0)).toBe("just now");
    expect(formatWait(-500)).toBe("just now");
  });

  it("formats sub-minute waits as seconds", () => {
    expect(formatWait(45_000)).toBe("45s");
  });

  it("formats sub-hour waits as minutes", () => {
    expect(formatWait(5 * 60_000)).toBe("5m");
  });

  it("formats sub-day waits as hours and minutes", () => {
    expect(formatWait(3 * 3_600_000 + 20 * 60_000)).toBe("3h 20m");
  });

  it("formats multi-day waits as days and hours", () => {
    expect(formatWait(2 * 86_400_000 + 5 * 3_600_000)).toBe("2d 5h");
  });
});

describe("formatTokens", () => {
  it("passes small counts through unchanged", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats counts of 1000+ as one-decimal k", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(15_250)).toBe("15.3k");
  });
});
