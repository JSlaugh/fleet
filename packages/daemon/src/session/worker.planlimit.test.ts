import { describe, expect, it } from "vitest";
import { parseLimitReset } from "./worker.ts";

describe("parseLimitReset", () => {
  it("parses the historical epoch-seconds suffix format", () => {
    const reset = parseLimitReset("Claude AI usage limit reached|1735689600");
    expect(reset).toEqual(new Date(1735689600 * 1000));
  });

  it("parses a human-readable reset time", () => {
    const reset = parseLimitReset("Claude AI usage limit reached, resets January 1, 2026 5:00 PM UTC");
    expect(reset).toEqual(new Date("January 1, 2026 5:00 PM UTC"));
  });

  it("parses a reset time introduced with 'resets at'", () => {
    const reset = parseLimitReset("usage limit reached, resets at 2026-01-01T17:00:00.000Z");
    expect(reset).toEqual(new Date("2026-01-01T17:00:00.000Z"));
  });

  it("returns undefined when a limit message carries no parseable reset time", () => {
    expect(parseLimitReset("Claude AI usage limit reached")).toBeUndefined();
    expect(parseLimitReset("Claude AI usage limit reached|not-a-number")).toBeUndefined();
  });

  it("returns undefined for unrelated (garbage) text", () => {
    expect(parseLimitReset("")).toBeUndefined();
    expect(parseLimitReset("just a normal assistant reply")).toBeUndefined();
    expect(parseLimitReset("network error, please retry")).toBeUndefined();
  });

  it("is case-insensitive when detecting the limit phrase", () => {
    const reset = parseLimitReset("CLAUDE AI USAGE LIMIT REACHED|1735689600");
    expect(reset).toEqual(new Date(1735689600 * 1000));
  });
});
