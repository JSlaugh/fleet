import { describe, expect, it } from "vitest";
import { makeCtx, makeFleetConfig } from "../test-support.ts";
import { resolveTimeoutMinutes } from "./supervise.ts";

describe("resolveTimeoutMinutes", () => {
  it("falls back to the global ticketTimeoutMinutes when the body has no Timeout line", () => {
    const ctx = makeCtx({ config: makeFleetConfig({ ticketTimeoutMinutes: 30 }) });
    expect(resolveTimeoutMinutes(ctx, "alpha#1", "Just a plain description.")).toBe(30);
  });

  it("honors a per-ticket Timeout override under the max", () => {
    const ctx = makeCtx({ config: makeFleetConfig({ ticketTimeoutMinutes: 30 }) });
    expect(resolveTimeoutMinutes(ctx, "alpha#1", "Timeout: 90m")).toBe(90);
  });

  it("clamps a Timeout above the max and still returns the clamped value", () => {
    const ctx = makeCtx({ config: makeFleetConfig({ ticketTimeoutMinutes: 30 }) });
    expect(resolveTimeoutMinutes(ctx, "alpha#1", "Timeout: 6h")).toBe(240);
  });

  it("falls back to the global value when the Timeout line is malformed", () => {
    const ctx = makeCtx({ config: makeFleetConfig({ ticketTimeoutMinutes: 30 }) });
    expect(resolveTimeoutMinutes(ctx, "alpha#1", "Timeout: soon")).toBe(30);
  });
});
