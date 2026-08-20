<script setup lang="ts">
import { computed, ref } from "vue";
import type { HistoryWeeklyBucket, ModelTier } from "@fleet/shared";

const props = defineProps<{ buckets: HistoryWeeklyBucket[] }>();

const TIERS: ModelTier[] = ["base", "light", "elevated"];
const TIER_LABEL: Record<ModelTier, string> = { base: "Base", light: "Light", elevated: "Elevated" };

const activeTiers = ref<Set<ModelTier>>(new Set(TIERS));
function toggleTier(tier: ModelTier) {
  const next = new Set(activeTiers.value);
  if (next.has(tier)) {
    if (next.size > 1) next.delete(tier);
  } else {
    next.add(tier);
  }
  activeTiers.value = next;
}
const shownTiers = computed(() => TIERS.filter((t) => activeTiers.value.has(t)));

// Shared virtual canvas — every chart plots against the same week bands so a
// hovered week lines up across all three, and the SVG scales fluidly via
// viewBox rather than a measured pixel width.
const CHART_W = 800;
const PAD_L = 44;
const PAD_R = 8;
const INNER_W = CHART_W - PAD_L - PAD_R;

const weekCount = computed(() => props.buckets.length);
const bandW = computed(() => (weekCount.value > 0 ? INNER_W / weekCount.value : 0));

/** Which x-axis week labels to draw — first, last, and evenly spaced in between, thinned so labels don't collide. */
const labelIndices = computed(() => {
  const n = weekCount.value;
  if (n === 0) return [];
  if (n <= 6) return props.buckets.map((_, i) => i);
  const step = Math.ceil(n / 6);
  const indices = new Set<number>();
  for (let i = 0; i < n; i += step) indices.add(i);
  indices.add(n - 1);
  return [...indices].sort((a, b) => a - b);
});

function shortWeek(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00.000Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n >= 10 ? 0 : 2)}`;
}

const hoveredIndex = ref<number | null>(null);
const hoveredBucket = computed(() => (hoveredIndex.value === null ? undefined : props.buckets[hoveredIndex.value]));
const hoveredX = computed(() =>
  hoveredIndex.value === null ? 0 : PAD_L + (hoveredIndex.value + 0.5) * bandW.value,
);

// ── Chart 1: weekly spend, stacked by tier ─────────────────────────────────
const SPEND_H = 160;
const SPEND_PAD_T = 10;
const SPEND_PAD_B = 22;
const SPEND_INNER_H = SPEND_H - SPEND_PAD_T - SPEND_PAD_B;

const spendMax = computed(() => {
  const totals = props.buckets.map((b) => shownTiers.value.reduce((s, t) => s + b.spendUsd[t], 0));
  return Math.max(1, ...totals);
});

const spendBars = computed(() =>
  props.buckets.map((b, i) => {
    const barW = bandW.value * 0.62;
    const x = PAD_L + i * bandW.value + (bandW.value - barW) / 2;
    let cursor = 0;
    const segments = shownTiers.value
      .filter((t) => b.spendUsd[t] > 0)
      .map((t) => {
        const value = b.spendUsd[t];
        const height = (value / spendMax.value) * SPEND_INNER_H;
        const y = SPEND_PAD_T + SPEND_INNER_H - cursor - height;
        cursor += height;
        return { tier: t, y, height, value };
      });
    return { weekStart: b.weekStart, x, width: barW, segments };
  }),
);

const spendTicks = computed(() => {
  const max = spendMax.value;
  return [0, max / 2, max].map((v) => ({
    value: v,
    y: SPEND_PAD_T + SPEND_INNER_H - (v / max) * SPEND_INNER_H,
  }));
});

// ── Chart 2: weekly completed vs failed ─────────────────────────────────────
const OUTCOME_H = 140;
const OUTCOME_PAD_T = 10;
const OUTCOME_PAD_B = 22;
const OUTCOME_INNER_H = OUTCOME_H - OUTCOME_PAD_T - OUTCOME_PAD_B;

const outcomeMax = computed(() => {
  const values = props.buckets.flatMap((b) => [
    shownTiers.value.reduce((s, t) => s + b.completed[t], 0),
    shownTiers.value.reduce((s, t) => s + b.failed[t], 0),
  ]);
  return Math.max(1, ...values);
});

const outcomeBars = computed(() =>
  props.buckets.map((b, i) => {
    const groupW = bandW.value * 0.62;
    const barW = groupW / 2 - 1;
    const groupX = PAD_L + i * bandW.value + (bandW.value - groupW) / 2;
    const completed = shownTiers.value.reduce((s, t) => s + b.completed[t], 0);
    const failed = shownTiers.value.reduce((s, t) => s + b.failed[t], 0);
    const completedH = (completed / outcomeMax.value) * OUTCOME_INNER_H;
    const failedH = (failed / outcomeMax.value) * OUTCOME_INNER_H;
    return {
      weekStart: b.weekStart,
      completed: { x: groupX, width: barW, y: OUTCOME_PAD_T + OUTCOME_INNER_H - completedH, height: completedH, value: completed },
      failed: {
        x: groupX + barW + 2,
        width: barW,
        y: OUTCOME_PAD_T + OUTCOME_INNER_H - failedH,
        height: failedH,
        value: failed,
      },
    };
  }),
);

const outcomeTicks = computed(() => {
  const max = outcomeMax.value;
  const step = Math.max(1, Math.round(max / 2));
  const ticks = [0, step, step * 2].filter((v) => v <= max || v === 0);
  return ticks.map((v) => ({ value: v, y: OUTCOME_PAD_T + OUTCOME_INNER_H - (v / max) * OUTCOME_INNER_H }));
});

// ── Chart 3: cost per cleanly-merged PR, by tier ────────────────────────────
const COST_H = 150;
const COST_PAD_T = 10;
const COST_PAD_B = 22;
const COST_INNER_H = COST_H - COST_PAD_T - COST_PAD_B;

/** Undefined for a (week, tier) with no cleanly-merged PR that week — a gap, not a zero. */
const costPerMergePoints = computed(() => {
  const points: Record<ModelTier, ({ x: number; y: number; value: number } | undefined)[]> = {
    base: [],
    light: [],
    elevated: [],
  };
  for (const tier of TIERS) {
    points[tier] = props.buckets.map((b, i) => {
      const count = b.cleanMergeCount[tier];
      if (count <= 0) return undefined;
      const value = b.cleanMergeCostUsd[tier] / count;
      return { x: PAD_L + (i + 0.5) * bandW.value, y: 0, value };
    });
  }
  return points;
});

const costMax = computed(() => {
  const values = TIERS.flatMap((t) => costPerMergePoints.value[t].filter(Boolean).map((p) => p!.value));
  return Math.max(1, ...values);
});

/** Contiguous-run path segments per tier — a gap week starts a new segment instead of connecting across it. */
const costSeries = computed(() =>
  shownTiers.value.map((tier) => {
    const raw = costPerMergePoints.value[tier];
    const plotted = raw.map((p) => (p ? { ...p, y: COST_PAD_T + COST_INNER_H - (p.value / costMax.value) * COST_INNER_H } : undefined));
    const paths: string[] = [];
    let current: string[] = [];
    for (const p of plotted) {
      if (!p) {
        if (current.length > 1) paths.push(current.join(" "));
        current = [];
        continue;
      }
      current.push(`${current.length === 0 ? "M" : "L"}${p.x},${p.y}`);
    }
    if (current.length > 1) paths.push(current.join(" "));
    return { tier, paths, points: plotted.filter((p): p is NonNullable<typeof p> => Boolean(p)) };
  }),
);

const costTicks = computed(() => {
  const max = costMax.value;
  return [0, max / 2, max].map((v) => ({ value: v, y: COST_PAD_T + COST_INNER_H - (v / max) * COST_INNER_H }));
});

const showTable = ref(false);
</script>

<template>
  <div v-if="buckets.length === 0" class="mb-4 rounded border border-neutral-200 p-4 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
    Not enough closed tickets yet to chart weekly trends.
  </div>

  <div v-else class="viz-root mb-4 rounded border border-neutral-200 p-3 dark:border-neutral-700">
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="tier in TIERS"
          :key="tier"
          type="button"
          class="flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px]"
          :class="
            activeTiers.has(tier)
              ? 'border-neutral-300 dark:border-neutral-600'
              : 'border-neutral-200 text-neutral-400 dark:border-neutral-800 dark:text-neutral-600'
          "
          @click="toggleTier(tier)"
        >
          <span class="size-2 rounded-sm" :class="`tier-swatch tier-${tier}`" :style="!activeTiers.has(tier) ? 'opacity: 0.3' : ''"></span>
          {{ TIER_LABEL[tier] }}
        </button>
      </div>
      <button
        type="button"
        class="rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
        @click="showTable = !showTable"
      >
        {{ showTable ? "Hide table" : "Show as table" }}
      </button>
    </div>

    <!-- Weekly spend, stacked by tier -->
    <div class="relative mb-4">
      <div class="mb-1 text-[11px] uppercase tracking-wide text-neutral-400">Weekly spend</div>
      <svg :viewBox="`0 0 ${CHART_W} ${SPEND_H}`" class="w-full" preserveAspectRatio="none" style="height: 130px">
        <line
          v-for="tick in spendTicks"
          :key="tick.value"
          :x1="PAD_L"
          :x2="CHART_W - PAD_R"
          :y1="tick.y"
          :y2="tick.y"
          class="gridline"
        />
        <text v-for="tick in spendTicks" :key="`t${tick.value}`" :x="PAD_L - 4" :y="tick.y + 3" class="axis-label" text-anchor="end">
          {{ fmtUsd(tick.value) }}
        </text>
        <g v-for="(bar, i) in spendBars" :key="bar.weekStart">
          <rect
            v-for="seg in bar.segments"
            :key="seg.tier"
            :x="bar.x"
            :y="seg.y"
            :width="bar.width"
            :height="Math.max(seg.height, seg.height > 0 ? 1 : 0)"
            :class="`tier-fill tier-${seg.tier}`"
            rx="1.5"
          />
          <rect
            :x="PAD_L + i * bandW"
            y="0"
            :width="bandW"
            :height="SPEND_H"
            fill="transparent"
            @mouseenter="hoveredIndex = i"
            @mouseleave="hoveredIndex = null"
          />
        </g>
        <line v-if="hoveredIndex !== null" :x1="hoveredX" :x2="hoveredX" y1="0" :y2="SPEND_H - SPEND_PAD_B" class="crosshair" />
        <text
          v-for="i in labelIndices"
          :key="`w${i}`"
          :x="PAD_L + (i + 0.5) * bandW"
          :y="SPEND_H - 6"
          class="axis-label"
          text-anchor="middle"
        >
          {{ shortWeek(buckets[i]!.weekStart) }}
        </text>
      </svg>
      <div
        v-if="hoveredBucket"
        class="tooltip"
        :style="{ left: `${(hoveredX / CHART_W) * 100}%` }"
      >
        <div class="tooltip-title">Week of {{ shortWeek(hoveredBucket.weekStart) }}</div>
        <div v-for="tier in shownTiers" :key="tier" v-show="hoveredBucket.spendUsd[tier] > 0" class="tooltip-row">
          <span class="tier-swatch" :class="`tier-${tier}`"></span>{{ TIER_LABEL[tier] }}: {{ fmtUsd(hoveredBucket.spendUsd[tier]) }}
        </div>
      </div>
    </div>

    <!-- Weekly completed vs failed -->
    <div class="relative mb-4">
      <div class="mb-1 text-[11px] uppercase tracking-wide text-neutral-400">Tickets completed vs. failed</div>
      <svg :viewBox="`0 0 ${CHART_W} ${OUTCOME_H}`" class="w-full" preserveAspectRatio="none" style="height: 115px">
        <line
          v-for="tick in outcomeTicks"
          :key="tick.value"
          :x1="PAD_L"
          :x2="CHART_W - PAD_R"
          :y1="tick.y"
          :y2="tick.y"
          class="gridline"
        />
        <text v-for="tick in outcomeTicks" :key="`t${tick.value}`" :x="PAD_L - 4" :y="tick.y + 3" class="axis-label" text-anchor="end">
          {{ tick.value }}
        </text>
        <g v-for="(bar, i) in outcomeBars" :key="bar.weekStart">
          <rect :x="bar.completed.x" :y="bar.completed.y" :width="bar.completed.width" :height="bar.completed.height" class="status-good" rx="1.5" />
          <rect :x="bar.failed.x" :y="bar.failed.y" :width="bar.failed.width" :height="bar.failed.height" class="status-critical" rx="1.5" />
          <rect
            :x="PAD_L + i * bandW"
            y="0"
            :width="bandW"
            :height="OUTCOME_H"
            fill="transparent"
            @mouseenter="hoveredIndex = i"
            @mouseleave="hoveredIndex = null"
          />
        </g>
        <line v-if="hoveredIndex !== null" :x1="hoveredX" :x2="hoveredX" y1="0" :y2="OUTCOME_H - OUTCOME_PAD_B" class="crosshair" />
        <text
          v-for="i in labelIndices"
          :key="`w${i}`"
          :x="PAD_L + (i + 0.5) * bandW"
          :y="OUTCOME_H - 6"
          class="axis-label"
          text-anchor="middle"
        >
          {{ shortWeek(buckets[i]!.weekStart) }}
        </text>
      </svg>
      <div v-if="hoveredBucket" class="tooltip" :style="{ left: `${(hoveredX / CHART_W) * 100}%` }">
        <div class="tooltip-title">Week of {{ shortWeek(hoveredBucket.weekStart) }}</div>
        <div class="tooltip-row"><span class="status-good-dot"></span>Completed: {{ shownTiers.reduce((s, t) => s + hoveredBucket!.completed[t], 0) }}</div>
        <div class="tooltip-row"><span class="status-critical-dot"></span>Failed: {{ shownTiers.reduce((s, t) => s + hoveredBucket!.failed[t], 0) }}</div>
      </div>
      <div class="mt-1 flex gap-3 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span class="flex items-center gap-1"><span class="status-good-dot"></span>Completed</span>
        <span class="flex items-center gap-1"><span class="status-critical-dot"></span>Failed</span>
      </div>
    </div>

    <!-- Cost per cleanly-merged PR, by tier -->
    <div class="relative">
      <div class="mb-1 text-[11px] uppercase tracking-wide text-neutral-400">Cost per cleanly merged PR, by tier</div>
      <svg :viewBox="`0 0 ${CHART_W} ${COST_H}`" class="w-full" preserveAspectRatio="none" style="height: 120px">
        <line v-for="tick in costTicks" :key="tick.value" :x1="PAD_L" :x2="CHART_W - PAD_R" :y1="tick.y" :y2="tick.y" class="gridline" />
        <text v-for="tick in costTicks" :key="`t${tick.value}`" :x="PAD_L - 4" :y="tick.y + 3" class="axis-label" text-anchor="end">
          {{ fmtUsd(tick.value) }}
        </text>
        <g v-for="series in costSeries" :key="series.tier">
          <path v-for="(d, si) in series.paths" :key="si" :d="d" fill="none" :class="`tier-stroke tier-${series.tier}`" />
          <circle v-for="(p, pi) in series.points" :key="pi" :cx="p.x" :cy="p.y" r="2.5" :class="`tier-fill tier-${series.tier}`" />
        </g>
        <g v-for="(b, i) in buckets" :key="b.weekStart">
          <rect
            :x="PAD_L + i * bandW"
            y="0"
            :width="bandW"
            :height="COST_H"
            fill="transparent"
            @mouseenter="hoveredIndex = i"
            @mouseleave="hoveredIndex = null"
          />
        </g>
        <line v-if="hoveredIndex !== null" :x1="hoveredX" :x2="hoveredX" y1="0" :y2="COST_H - COST_PAD_B" class="crosshair" />
        <text
          v-for="i in labelIndices"
          :key="`w${i}`"
          :x="PAD_L + (i + 0.5) * bandW"
          :y="COST_H - 6"
          class="axis-label"
          text-anchor="middle"
        >
          {{ shortWeek(buckets[i]!.weekStart) }}
        </text>
      </svg>
      <div v-if="hoveredBucket" class="tooltip" :style="{ left: `${(hoveredX / CHART_W) * 100}%` }">
        <div class="tooltip-title">Week of {{ shortWeek(hoveredBucket.weekStart) }}</div>
        <div v-for="tier in shownTiers" :key="tier" v-show="hoveredBucket.cleanMergeCount[tier] > 0" class="tooltip-row">
          <span class="tier-swatch" :class="`tier-${tier}`"></span>{{ TIER_LABEL[tier] }}:
          {{ fmtUsd(hoveredBucket.cleanMergeCostUsd[tier] / hoveredBucket.cleanMergeCount[tier]) }}
          ({{ hoveredBucket.cleanMergeCount[tier] }} PR{{ hoveredBucket.cleanMergeCount[tier] === 1 ? "" : "s" }})
        </div>
        <div v-if="shownTiers.every((t) => hoveredBucket!.cleanMergeCount[t] === 0)" class="tooltip-row text-neutral-400">
          No cleanly merged PRs this week
        </div>
      </div>
      <div class="mt-1 flex flex-wrap gap-3 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span v-for="tier in shownTiers" :key="tier" class="flex items-center gap-1">
          <span class="tier-swatch" :class="`tier-${tier}`"></span>{{ TIER_LABEL[tier] }}
        </span>
      </div>
    </div>

    <details v-if="showTable" class="mt-3 text-xs" open>
      <summary class="cursor-pointer text-neutral-400">Weekly data</summary>
      <table class="mt-2 w-full text-left text-[11px]">
        <thead class="text-neutral-400 dark:text-neutral-500">
          <tr>
            <th class="py-1 pr-2 font-medium">Week of</th>
            <th v-for="tier in TIERS" :key="tier" class="py-1 pr-2 font-medium">{{ TIER_LABEL[tier] }} spend</th>
            <th class="py-1 pr-2 font-medium">Completed</th>
            <th class="py-1 pr-2 font-medium">Failed</th>
            <th v-for="tier in TIERS" :key="`${tier}-cost`" class="py-1 pr-2 font-medium">{{ TIER_LABEL[tier] }} $/merged PR</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in buckets" :key="b.weekStart" class="border-t border-neutral-100 dark:border-neutral-800">
            <td class="py-1 pr-2">{{ shortWeek(b.weekStart) }}</td>
            <td v-for="tier in TIERS" :key="tier" class="py-1 pr-2">{{ fmtUsd(b.spendUsd[tier]) }}</td>
            <td class="py-1 pr-2">{{ TIERS.reduce((s, t) => s + b.completed[t], 0) }}</td>
            <td class="py-1 pr-2">{{ TIERS.reduce((s, t) => s + b.failed[t], 0) }}</td>
            <td v-for="tier in TIERS" :key="`${tier}-cost`" class="py-1 pr-2">
              {{ b.cleanMergeCount[tier] > 0 ? fmtUsd(b.cleanMergeCostUsd[tier] / b.cleanMergeCount[tier]) : "—" }}
            </td>
          </tr>
        </tbody>
      </table>
    </details>
  </div>
</template>

<style scoped>
.viz-root {
  --gridline: #e1e0d9;
  --axis-label: #898781;
  --crosshair: #c3c2b7;
  --tier-base: #2a78d6;
  --tier-light: #eb6834;
  --tier-elevated: #1baf7a;
  --status-good: #0ca30c;
  --status-critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  .viz-root {
    --gridline: #2c2c2a;
    --axis-label: #898781;
    --crosshair: #383835;
    --tier-base: #3987e5;
    --tier-light: #d95926;
    --tier-elevated: #199e70;
  }
}

.gridline {
  stroke: var(--gridline);
  stroke-width: 1;
}
.axis-label {
  fill: var(--axis-label);
  font-size: 9px;
}
.crosshair {
  stroke: var(--crosshair);
  stroke-width: 1;
  stroke-dasharray: 2 2;
}
.tier-fill.tier-base,
.tier-swatch.tier-base {
  fill: var(--tier-base);
  background-color: var(--tier-base);
}
.tier-fill.tier-light,
.tier-swatch.tier-light {
  fill: var(--tier-light);
  background-color: var(--tier-light);
}
.tier-fill.tier-elevated,
.tier-swatch.tier-elevated {
  fill: var(--tier-elevated);
  background-color: var(--tier-elevated);
}
.tier-stroke.tier-base {
  stroke: var(--tier-base);
  stroke-width: 2;
}
.tier-stroke.tier-light {
  stroke: var(--tier-light);
  stroke-width: 2;
}
.tier-stroke.tier-elevated {
  stroke: var(--tier-elevated);
  stroke-width: 2;
}
.tier-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.status-good {
  fill: var(--status-good);
}
.status-critical {
  fill: var(--status-critical);
}
.status-good-dot,
.status-critical-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 9999px;
}
.status-good-dot {
  background-color: var(--status-good);
}
.status-critical-dot {
  background-color: var(--status-critical);
}
.tooltip {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  background: rgba(20, 20, 18, 0.92);
  color: #fff;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 10px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 10;
}
.tooltip-title {
  font-weight: 600;
  margin-bottom: 2px;
}
.tooltip-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
