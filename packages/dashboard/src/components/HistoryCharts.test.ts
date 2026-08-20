import { mount } from "@vue/test-utils";
import type { HistoryWeeklyBucket } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import HistoryCharts from "./HistoryCharts.vue";

function tierTotals(overrides: Partial<Record<"elevated" | "light" | "base", number>> = {}) {
  return { elevated: 0, light: 0, base: 0, ...overrides };
}

function makeBucket(patch: Partial<HistoryWeeklyBucket> = {}): HistoryWeeklyBucket {
  return {
    weekStart: "2026-01-05",
    spendUsd: tierTotals(),
    completed: tierTotals(),
    failed: tierTotals(),
    cleanMergeCostUsd: tierTotals(),
    cleanMergeCount: tierTotals(),
    ...patch,
  };
}

describe("HistoryCharts", () => {
  it("shows a placeholder instead of empty axes when there's no history", () => {
    const wrapper = mount(HistoryCharts, { props: { buckets: [] } });
    expect(wrapper.text()).toContain("Not enough closed tickets yet");
    expect(wrapper.find("svg").exists()).toBe(false);
  });

  it("renders one stacked spend bar and one outcome bar per week", () => {
    const buckets = [
      makeBucket({
        weekStart: "2026-01-05",
        spendUsd: tierTotals({ base: 1, elevated: 2 }),
        completed: tierTotals({ base: 1 }),
        failed: tierTotals({ light: 1 }),
      }),
      makeBucket({
        weekStart: "2026-01-12",
        spendUsd: tierTotals({ base: 3 }),
        completed: tierTotals({ base: 2 }),
      }),
    ];
    const wrapper = mount(HistoryCharts, { props: { buckets } });
    expect(wrapper.findAll("svg")).toHaveLength(3);
    // Week 1 has base+elevated spend (2 segments); week 2 has only base (1 segment).
    expect(wrapper.findAll(".tier-fill")).toHaveLength(3);
  });

  it("omits a tier's cost-per-merged-PR point for a week with no cleanly merged PR (gap, not zero)", () => {
    const buckets = [
      makeBucket({ weekStart: "2026-01-05", cleanMergeCostUsd: tierTotals({ base: 10 }), cleanMergeCount: tierTotals({ base: 1 }) }),
      makeBucket({ weekStart: "2026-01-12" }), // no clean merges at all this week
    ];
    const wrapper = mount(HistoryCharts, { props: { buckets } });
    // Only one week contributed a plotted point for the base tier's line.
    expect(wrapper.findAll("circle")).toHaveLength(1);
  });

  it("hides a tier's series from every chart when its legend chip is toggled off", async () => {
    const buckets = [
      makeBucket({
        weekStart: "2026-01-05",
        spendUsd: tierTotals({ base: 1, light: 2 }),
        cleanMergeCostUsd: tierTotals({ base: 5, light: 5 }),
        cleanMergeCount: tierTotals({ base: 1, light: 1 }),
      }),
    ];
    const wrapper = mount(HistoryCharts, { props: { buckets } });
    // 2 spend-bar segments (base, light) + 2 cost-per-PR line points (base, light).
    expect(wrapper.findAll(".tier-fill")).toHaveLength(4);
    const lightChip = wrapper.findAll("button").find((b) => b.text() === "Light");
    await lightChip!.trigger("click");
    expect(wrapper.find(".tier-light.tier-fill").exists()).toBe(false);
  });

  it("shows the weekly data table only after the toggle is clicked", async () => {
    const wrapper = mount(HistoryCharts, { props: { buckets: [makeBucket()] } });
    expect(wrapper.find("table").exists()).toBe(false);
    await wrapper.findAll("button").find((b) => b.text() === "Show as table")!.trigger("click");
    expect(wrapper.find("table").exists()).toBe(true);
  });
});
