import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { checkPlanLimit, parseLimitReset } from "./worker.ts";

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

describe("checkPlanLimit", () => {
  it("reports a plan limit from a rejected rate_limit_event, converting resetsAt from epoch seconds", () => {
    const message = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1735689600, rateLimitType: "five_hour" },
    } as unknown as SDKMessage;

    expect(checkPlanLimit(message)).toEqual({ limitResetAt: new Date(1735689600 * 1000) });
  });

  it("reports a plan limit with no reset time when a rejected event carries none", () => {
    const message = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected" },
    } as unknown as SDKMessage;

    expect(checkPlanLimit(message)).toEqual({ limitResetAt: undefined });
  });

  it("ignores allowed and allowed_warning rate_limit_events", () => {
    for (const status of ["allowed", "allowed_warning"]) {
      const message = {
        type: "rate_limit_event",
        rate_limit_info: { status, utilization: 0.8 },
      } as unknown as SDKMessage;

      expect(checkPlanLimit(message)).toBeUndefined();
    }
  });

  it("falls back to the legacy text-based detection when no structured event fires", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Claude AI usage limit reached|1735689600" }] },
    } as unknown as SDKMessage;

    expect(checkPlanLimit(message)).toEqual({ limitResetAt: new Date(1735689600 * 1000) });
  });

  it("returns undefined for a message matching neither signal", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "just talking" }] },
    } as unknown as SDKMessage;

    expect(checkPlanLimit(message)).toBeUndefined();
  });

  it("dedups across a stream: the structured event wins and a later legacy-text match on the same limit hit is never reached", () => {
    // Mirrors how nextResult/runReviewSession consume a message stream: iterate,
    // call checkPlanLimit per message, and stop at the first hit — so one limit
    // hit can never produce two plan-limit turn results even if both signals
    // eventually appear.
    const messages = [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1735689600 } },
      { type: "assistant", message: { content: [{ type: "text", text: "Claude AI usage limit reached|1735776000" }] } },
    ] as unknown as SDKMessage[];

    const hits: { limitResetAt?: Date }[] = [];
    for (const message of messages) {
      const hit = checkPlanLimit(message);
      if (hit) {
        hits.push(hit);
        break;
      }
    }

    expect(hits).toEqual([{ limitResetAt: new Date(1735689600 * 1000) }]);
  });
});
