import { WORK_DAYS, type FleetConfig, type WorkDay, type WorkHoursReserveConfig } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { makeCtx, makeFleetConfig } from "../test-support.ts";
import { computeWorkHoursReserveGate, computeWorkHoursReserveWindow, workHoursReserveStatus } from "./workHoursReserve.ts";
import type { LoopContext } from "./context.ts";

function dayOf(date: Date): WorkDay {
  return WORK_DAYS[date.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6];
}

function reserveConfig(overrides: Partial<WorkHoursReserveConfig> = {}): WorkHoursReserveConfig {
  return { workStart: "09:00", days: [...WORK_DAYS], reserveHours: 2, ...overrides };
}

describe("computeWorkHoursReserveWindow", () => {
  it("is inactive well before the reserve window", () => {
    const now = new Date(2026, 0, 5, 5, 0, 0); // Jan 5 2026, 05:00 — window is [07:00, 09:00)
    expect(computeWorkHoursReserveWindow(now, reserveConfig()).active).toBe(false);
  });

  it("is active inside the reserve window on a working day", () => {
    const now = new Date(2026, 0, 5, 8, 0, 0); // inside [07:00, 09:00)
    const result = computeWorkHoursReserveWindow(now, reserveConfig());
    expect(result.active).toBe(true);
    expect(result.releaseAt?.getHours()).toBe(9);
    expect(result.releaseAt?.getMinutes()).toBe(0);
    expect(result.releaseAt?.getDate()).toBe(5);
  });

  it("is inactive once work hours themselves begin", () => {
    const now = new Date(2026, 0, 5, 9, 0, 0); // exactly workStart
    expect(computeWorkHoursReserveWindow(now, reserveConfig()).active).toBe(false);
  });

  it("is inactive during the daytime, well after workStart", () => {
    const now = new Date(2026, 0, 5, 14, 0, 0);
    expect(computeWorkHoursReserveWindow(now, reserveConfig()).active).toBe(false);
  });

  it("is inactive on a non-working day even inside the clock window", () => {
    const now = new Date(2026, 0, 5, 8, 0, 0);
    const otherDays = WORK_DAYS.filter((d) => d !== dayOf(now));
    expect(computeWorkHoursReserveWindow(now, reserveConfig({ days: otherDays })).active).toBe(false);
  });

  it("handles a window crossing midnight, active before midnight, gated on the day work starts", () => {
    // workStart 01:00, reserveHours 3 -> window is [22:00 Jan 5, 01:00 Jan 6)
    const now = new Date(2026, 0, 5, 23, 0, 0);
    const workStartDay = new Date(2026, 0, 6, 1, 0, 0);
    const result = computeWorkHoursReserveWindow(
      now,
      reserveConfig({ workStart: "01:00", reserveHours: 3, days: [dayOf(workStartDay)] }),
    );
    expect(result.active).toBe(true);
    expect(result.releaseAt?.getDate()).toBe(6);
    expect(result.releaseAt?.getHours()).toBe(1);
  });

  it("handles a window crossing midnight, active after midnight before workStart", () => {
    const now = new Date(2026, 0, 6, 0, 30, 0);
    const result = computeWorkHoursReserveWindow(now, reserveConfig({ workStart: "01:00", reserveHours: 3, days: [dayOf(now)] }));
    expect(result.active).toBe(true);
  });

  it("a midnight-crossing window is inactive when the day work starts isn't a working day", () => {
    const now = new Date(2026, 0, 5, 23, 0, 0);
    const workStartDay = new Date(2026, 0, 6, 1, 0, 0);
    const otherDays = WORK_DAYS.filter((d) => d !== dayOf(workStartDay));
    const result = computeWorkHoursReserveWindow(now, reserveConfig({ workStart: "01:00", reserveHours: 3, days: otherDays }));
    expect(result.active).toBe(false);
  });

  it("a zero-length reserve is never active, regardless of the clock", () => {
    const now = new Date(2026, 0, 5, 9, 0, 0);
    expect(computeWorkHoursReserveWindow(now, reserveConfig({ reserveHours: 0 })).active).toBe(false);
  });
});

function ctxWith(configOverrides: Partial<FleetConfig> = {}): LoopContext {
  return makeCtx({ config: makeFleetConfig(configOverrides) });
}

// A window spanning a full day-plus so it always contains "now" no matter when
// this test runs, without depending on the real wall clock's exact value.
const ALWAYS_ACTIVE_RESERVE: WorkHoursReserveConfig = { workStart: "23:59", reserveHours: 25, days: [...WORK_DAYS] };
// windowStart == workStart, so the interval is empty and never contains "now".
const NEVER_ACTIVE_RESERVE: WorkHoursReserveConfig = { workStart: "09:00", reserveHours: 0, days: [...WORK_DAYS] };

describe("computeWorkHoursReserveGate", () => {
  it("is inactive when workHoursReserve is unset — feature off", () => {
    expect(computeWorkHoursReserveGate(ctxWith()).active).toBe(false);
  });

  it("is inactive when configured but the window doesn't contain now", () => {
    expect(computeWorkHoursReserveGate(ctxWith({ workHoursReserve: NEVER_ACTIVE_RESERVE })).active).toBe(false);
  });

  it("is active when configured and the window contains now", () => {
    const gate = computeWorkHoursReserveGate(ctxWith({ workHoursReserve: ALWAYS_ACTIVE_RESERVE }));
    expect(gate.active).toBe(true);
    expect(gate.releaseAt).toBeInstanceOf(Date);
  });
});

describe("workHoursReserveStatus", () => {
  it("is undefined when the feature is off, so the board hides it entirely", () => {
    expect(workHoursReserveStatus(ctxWith())).toBeUndefined();
  });

  it("reflects active/releaseAt when the feature is on and the window is active", () => {
    const status = workHoursReserveStatus(ctxWith({ workHoursReserve: ALWAYS_ACTIVE_RESERVE }));
    expect(status?.active).toBe(true);
    expect(typeof status?.releaseAt).toBe("string");
  });

  it("reflects active: false with no releaseAt when the feature is on but the window isn't active", () => {
    const status = workHoursReserveStatus(ctxWith({ workHoursReserve: NEVER_ACTIVE_RESERVE }));
    expect(status).toEqual({ active: false, releaseAt: undefined });
  });
});
