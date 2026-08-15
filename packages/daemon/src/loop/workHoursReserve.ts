import { WORK_DAYS, type WorkHoursReserveConfig, type WorkHoursReserveStatus } from "@fleet/shared";
import type { LoopContext } from "./context.ts";

export interface WorkHoursReserveWindow {
  active: boolean;
  /** The work-start instant the active window is guarding — only set while `active`. */
  releaseAt?: Date;
}

/**
 * Pure window check: is `now` inside `[workStart - reserveHours, workStart)`
 * on a configured working day? Checks `workStart` on the day before, the day
 * of, and the day after `now` so a window crossing midnight (e.g. `workStart:
 * "01:00"`, `reserveHours: 3` — the window starts at 22:00 the previous day)
 * is still caught, gated on the day work *starts* rather than the day the
 * window begins.
 */
export function computeWorkHoursReserveWindow(now: Date, config: WorkHoursReserveConfig): WorkHoursReserveWindow {
  const [hoursStr, minutesStr] = config.workStart.split(":");
  const hours = Number(hoursStr);
  const minutes = Number(minutesStr);
  for (const dayOffset of [-1, 0, 1]) {
    const workStart = new Date(now);
    workStart.setDate(workStart.getDate() + dayOffset);
    workStart.setHours(hours, minutes, 0, 0);
    const windowStartMs = workStart.getTime() - config.reserveHours * 60 * 60 * 1000;
    if (now.getTime() < windowStartMs || now.getTime() >= workStart.getTime()) continue;
    const weekday = WORK_DAYS[workStart.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6];
    if (!config.days.includes(weekday)) continue;
    return { active: true, releaseAt: workStart };
  }
  return { active: false };
}

/** Daemon-wide claim gate, consulted fresh each cycle. `active: false` when the feature is off (`workHoursReserve` unset). */
export function computeWorkHoursReserveGate(ctx: LoopContext): WorkHoursReserveWindow {
  const config = ctx.config.workHoursReserve;
  if (!config) return { active: false };
  return computeWorkHoursReserveWindow(new Date(), config);
}

/** The board payload's view of the reserve — `undefined` (not just `active: false`) when the feature is off, so the dashboard can hide it entirely. */
export function workHoursReserveStatus(ctx: LoopContext): WorkHoursReserveStatus | undefined {
  if (!ctx.config.workHoursReserve) return undefined;
  const window = computeWorkHoursReserveGate(ctx);
  return { active: window.active, releaseAt: window.releaseAt?.toISOString() };
}
