<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
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

// Charts draw 1:1 in pixels at the measured container width — never a stretched
// viewBox (`preserveAspectRatio="none"` distorts text and radii non-uniformly).
const rootEl = ref<HTMLElement>();
const chartW = ref(800);
const resizeObserver =
  typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width;
        if (w) chartW.value = Math.max(320, w);
      });
// The root only exists once buckets arrive (the empty state renders first), so
// observe reactively rather than once at mount.
watch(rootEl, (el, prev) => {
  if (prev) resizeObserver?.unobserve(prev);
  if (el) resizeObserver?.observe(el);
});
onUnmounted(() => resizeObserver?.disconnect());

const PAD_L = 40;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 24;
/** Surface-colored breathing room between touching marks (stacked segments, grouped bars). */
const GAP = 2;
const innerW = computed(() => chartW.value - PAD_L - PAD_R);

const weekCount = computed(() => props.buckets.length);
const bandW = computed(() => (weekCount.value > 0 ? innerW.value / weekCount.value : 0));

/** Which x-axis week labels to draw — first, last, and evenly spaced in between, thinned so labels don't collide. */
const labelIndices = computed(() => {
  const n = weekCount.value;
  if (n === 0) return [];
  const maxLabels = Math.max(3, Math.floor(innerW.value / 90));
  if (n <= maxLabels) return props.buckets.map((_, i) => i);
  const step = Math.ceil(n / maxLabels);
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

/** Axis ticks stay clean: whole dollars whenever the value is whole ($0, $50), cents only when fractional. */
function fmtUsdTick(n: number): string {
  return `$${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)}`;
}

/** Round a data max up to a clean axis max (1/2/2.5/5 × 10^k; integers only when asked). */
function niceCeil(v: number, integersOnly = false): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const multipliers = integersOnly && pow < 10 ? [1, 2, 4, 5, 10] : [1, 2, 2.5, 5, 10];
  for (const m of multipliers) {
    const candidate = m * pow;
    if (v <= candidate && (!integersOnly || Number.isInteger(candidate))) return candidate;
  }
  return 10 * pow;
}

/** Bar path rounded at the data end only — square at the baseline. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0 || w <= 0) return "";
  const radius = Math.min(r, w / 2, h);
  return [
    `M${x},${y + h}`,
    `L${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `L${x + w - radius},${y}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `L${x + w},${y + h}`,
    "Z",
  ].join(" ");
}

const hoveredIndex = ref<number | null>(null);
const hoveredBucket = computed(() => (hoveredIndex.value === null ? undefined : props.buckets[hoveredIndex.value]));
const hoveredX = computed(() =>
  hoveredIndex.value === null ? 0 : PAD_L + (hoveredIndex.value + 0.5) * bandW.value,
);
/** Tooltip anchor, clamped so it never overflows the card at the edges. */
const tooltipLeft = computed(() => Math.min(Math.max(hoveredX.value, 90), chartW.value - 90));

// ── Chart 1: weekly spend, stacked by tier ─────────────────────────────────
const SPEND_INNER_H = 120;
const SPEND_H = PAD_T + SPEND_INNER_H + PAD_B;

const spendMax = computed(() =>
  niceCeil(Math.max(0.01, ...props.buckets.map((b) => shownTiers.value.reduce((s, t) => s + b.spendUsd[t], 0)))),
);

const spendBars = computed(() =>
  props.buckets.map((b, i) => {
    const barW = Math.min(24, bandW.value * 0.55);
    const x = PAD_L + i * bandW.value + (bandW.value - barW) / 2;
    let cursor = 0;
    const stacked = shownTiers.value
      .filter((t) => b.spendUsd[t] > 0)
      .map((t) => {
        const value = b.spendUsd[t];
        const height = (value / spendMax.value) * SPEND_INNER_H;
        const y = PAD_T + SPEND_INNER_H - cursor - height;
        cursor += height;
        return { tier: t, y, height, value };
      });
    // 2px surface gaps between segments: shave the shared edges, keep the
    // baseline square and the data end intact for its 4px radius.
    const segments = stacked.map((seg, si) => {
      const isTop = si === stacked.length - 1;
      const isBottom = si === 0;
      const shaveTop = isTop ? 0 : GAP / 2;
      const shaveBottom = isBottom ? 0 : GAP / 2;
      const drawH = Math.max(seg.height - shaveTop - shaveBottom, seg.height > 0 ? 1 : 0);
      return { tier: seg.tier, y: seg.y + shaveTop, height: drawH, isTop };
    });
    return { weekStart: b.weekStart, x, width: barW, segments };
  }),
);

const spendTicks = computed(() =>
  [0, spendMax.value / 2, spendMax.value].map((v) => ({
    value: v,
    y: PAD_T + SPEND_INNER_H - (v / spendMax.value) * SPEND_INNER_H,
  })),
);

// ── Chart 2: weekly completed vs failed ─────────────────────────────────────
const OUTCOME_INNER_H = 96;
const OUTCOME_H = PAD_T + OUTCOME_INNER_H + PAD_B;

const outcomeMax = computed(() =>
  niceCeil(
    Math.max(
      1,
      ...props.buckets.flatMap((b) => [
        shownTiers.value.reduce((s, t) => s + b.completed[t], 0),
        shownTiers.value.reduce((s, t) => s + b.failed[t], 0),
      ]),
    ),
    true,
  ),
);

const outcomeBars = computed(() =>
  props.buckets.map((b, i) => {
    const barW = Math.min(14, bandW.value * 0.24);
    const groupW = barW * 2 + GAP;
    const groupX = PAD_L + i * bandW.value + (bandW.value - groupW) / 2;
    const completed = shownTiers.value.reduce((s, t) => s + b.completed[t], 0);
    const failed = shownTiers.value.reduce((s, t) => s + b.failed[t], 0);
    const completedH = (completed / outcomeMax.value) * OUTCOME_INNER_H;
    const failedH = (failed / outcomeMax.value) * OUTCOME_INNER_H;
    return {
      weekStart: b.weekStart,
      completed: { x: groupX, width: barW, y: PAD_T + OUTCOME_INNER_H - completedH, height: completedH, value: completed },
      failed: { x: groupX + barW + GAP, width: barW, y: PAD_T + OUTCOME_INNER_H - failedH, height: failedH, value: failed },
    };
  }),
);

const outcomeTicks = computed(() => {
  const max = outcomeMax.value;
  const values = [...new Set([0, Math.round(max / 2), max])];
  return values.map((v) => ({ value: v, y: PAD_T + OUTCOME_INNER_H - (v / max) * OUTCOME_INNER_H }));
});

// ── Chart 3: cost per cleanly-merged PR, by tier ────────────────────────────
const COST_INNER_H = 104;
const COST_H = PAD_T + COST_INNER_H + PAD_B;

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

const costMax = computed(() =>
  niceCeil(Math.max(0.01, ...TIERS.flatMap((t) => costPerMergePoints.value[t].filter(Boolean).map((p) => p!.value)))),
);

/** Contiguous-run path segments per tier — a gap week starts a new segment instead of connecting across it. */
const costSeries = computed(() =>
  shownTiers.value.map((tier) => {
    const raw = costPerMergePoints.value[tier];
    const plotted = raw.map((p) => (p ? { ...p, y: PAD_T + COST_INNER_H - (p.value / costMax.value) * COST_INNER_H } : undefined));
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

const costTicks = computed(() =>
  [0, costMax.value / 2, costMax.value].map((v) => ({
    value: v,
    y: PAD_T + COST_INNER_H - (v / costMax.value) * COST_INNER_H,
  })),
);

const showTable = ref(false);
</script>

<template>
  <div v-if="buckets.length === 0" class="mb-4 rounded-lg border bg-card p-4 text-xs text-muted-foreground">
    Not enough closed tickets yet to chart weekly trends.
  </div>

  <div v-else ref="rootEl" class="viz-root mb-4 rounded-lg border bg-card p-4">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap gap-1">
        <button
          v-for="tier in TIERS"
          :key="tier"
          type="button"
          class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors"
          :class="activeTiers.has(tier) ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'"
          @click="toggleTier(tier)"
        >
          <span
            class="size-2 rounded-full"
            :class="`tier-swatch tier-${tier}`"
            :style="!activeTiers.has(tier) ? 'opacity: 0.35' : ''"
          ></span>
          {{ TIER_LABEL[tier] }}
        </button>
      </div>
      <button
        type="button"
        class="rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/50"
        @click="showTable = !showTable"
      >
        {{ showTable ? "Hide table" : "Show as table" }}
      </button>
    </div>

    <!-- Weekly spend, stacked by tier -->
    <div class="relative mb-5">
      <div class="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Weekly spend</div>
      <svg :width="chartW" :height="SPEND_H" class="block">
        <line
          v-for="tick in spendTicks"
          :key="tick.value"
          :x1="PAD_L"
          :x2="chartW - PAD_R"
          :y1="tick.y"
          :y2="tick.y"
          :class="tick.value === 0 ? 'baseline' : 'gridline'"
        />
        <text v-for="tick in spendTicks" :key="`t${tick.value}`" :x="PAD_L - 6" :y="tick.y + 3" class="axis-label" text-anchor="end">
          {{ fmtUsdTick(tick.value) }}
        </text>
        <g v-for="(bar, i) in spendBars" :key="bar.weekStart">
          <template v-for="seg in bar.segments" :key="seg.tier">
            <path
              v-if="seg.isTop"
              :d="topRoundedRect(bar.x, seg.y, bar.width, seg.height, 4)"
              :class="`tier-fill tier-${seg.tier}`"
            />
            <rect
              v-else
              :x="bar.x"
              :y="seg.y"
              :width="bar.width"
              :height="seg.height"
              :class="`tier-fill tier-${seg.tier}`"
            />
          </template>
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
        <line v-if="hoveredIndex !== null" :x1="hoveredX" :x2="hoveredX" :y1="PAD_T" :y2="PAD_T + SPEND_INNER_H" class="crosshair" />
        <text
          v-for="i in labelIndices"
          :key="`w${i}`"
          :x="PAD_L + (i + 0.5) * bandW"
          :y="SPEND_H - 8"
          class="axis-label"
          text-anchor="middle"
        >
          {{ shortWeek(buckets[i]!.weekStart) }}
        </text>
      </svg>
      <div v-if="hoveredBucket" class="tooltip" :style="{ left: `${tooltipLeft}px` }">
        <div class="tooltip-title">Week of {{ shortWeek(hoveredBucket.weekStart) }}</div>
        <div v-for="tier in shownTiers" :key="tier" v-show="hoveredBucket.spendUsd[tier] > 0" class="tooltip-row">
          <span class="tier-swatch" :class="`tier-${tier}`"></span>
          <span class="tooltip-label">{{ TIER_LABEL[tier] }}</span>
          <span class="tooltip-value">{{ fmtUsd(hoveredBucket.spendUsd[tier]) }}</span>
        </div>
      </div>
    </div>

    <!-- Weekly completed vs failed -->
    <div class="relative mb-5">
      <div class="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tickets completed vs. failed</div>
      <svg :width="chartW" :height="OUTCOME_H" class="block">
        <line
          v-for="tick in outcomeTicks"
          :key="tick.value"
          :x1="PAD_L"
          :x2="chartW - PAD_R"
          :y1="tick.y"
          :y2="tick.y"
          :class="tick.value === 0 ? 'baseline' : 'gridline'"
        />
        <text v-for="tick in outcomeTicks" :key="`t${tick.value}`" :x="PAD_L - 6" :y="tick.y + 3" class="axis-label" text-anchor="end">
          {{ tick.value }}
        </text>
        <g v-for="(bar, i) in outcomeBars" :key="bar.weekStart">
          <path :d="topRoundedRect(bar.completed.x, bar.completed.y, bar.completed.width, bar.completed.height, 3)" class="status-good" />
          <path :d="topRoundedRect(bar.failed.x, bar.failed.y, bar.failed.width, bar.failed.height, 3)" class="status-critical" />
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
        <line v-if="hoveredIndex !== null" :x1="hoveredX" :x2="hoveredX" :y1="PAD_T" :y2="PAD_T + OUTCOME_INNER_H" class="crosshair" />
        <text
          v-for="i in labelIndices"
          :key="`w${i}`"
          :x="PAD_L + (i + 0.5) * bandW"
          :y="OUTCOME_H - 8"
          class="axis-label"
          text-anchor="middle"
        >
          {{ shortWeek(buckets[i]!.weekStart) }}
        </text>
      </svg>
      <div v-if="hoveredBucket" class="tooltip" :style="{ left: `${tooltipLeft}px` }">
        <div class="tooltip-title">Week of {{ shortWeek(hoveredBucket.weekStart) }}</div>
        <div class="tooltip-row">
          <span class="status-good-dot"></span>
          <span class="tooltip-label">Completed</span>
          <span class="tooltip-value">{{ shownTiers.reduce((s, t) => s + hoveredBucket!.completed[t], 0) }}</span>
        </div>
        <div class="tooltip-row">
          <span class="status-critical-dot"></span>
          <span class="tooltip-label">Failed</span>
          <span class="tooltip-value">{{ shownTiers.reduce((s, t) => s + hoveredBucket!.failed[t], 0) }}</span>
        </div>
      </div>
      <div class="mt-1.5 flex gap-3 text-[11px] text-muted-foreground">
        <span class="flex items-center gap-1.5"><span class="status-good-dot"></span>Completed</span>
        <span class="flex items-center gap-1.5"><span class="status-critical-dot"></span>Failed</span>
      </div>
    </div>

    <!-- Cost per cleanly-merged PR, by tier -->
    <div class="relative">
      <div class="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Cost per cleanly merged PR, by tier</div>
      <svg :width="chartW" :height="COST_H" class="block">
        <line
          v-for="tick in costTicks"
          :key="tick.value"
          :x1="PAD_L"
          :x2="chartW - PAD_R"
          :y1="tick.y"
          :y2="tick.y"
          :class="tick.value === 0 ? 'baseline' : 'gridline'"
        />
        <text v-for="tick in costTicks" :key="`t${tick.value}`" :x="PAD_L - 6" :y="tick.y + 3" class="axis-label" text-anchor="end">
          {{ fmtUsdTick(tick.value) }}
        </text>
        <g v-for="series in costSeries" :key="series.tier">
          <path v-for="(d, si) in series.paths" :key="si" :d="d" fill="none" :class="`tier-stroke tier-${series.tier}`" />
          <circle
            v-for="(p, pi) in series.points"
            :key="pi"
            :cx="p.x"
            :cy="p.y"
            r="4"
            class="point-ring"
            :class="`tier-fill tier-${series.tier}`"
          />
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
        <line v-if="hoveredIndex !== null" :x1="hoveredX" :x2="hoveredX" :y1="PAD_T" :y2="PAD_T + COST_INNER_H" class="crosshair" />
        <text
          v-for="i in labelIndices"
          :key="`w${i}`"
          :x="PAD_L + (i + 0.5) * bandW"
          :y="COST_H - 8"
          class="axis-label"
          text-anchor="middle"
        >
          {{ shortWeek(buckets[i]!.weekStart) }}
        </text>
      </svg>
      <div v-if="hoveredBucket" class="tooltip" :style="{ left: `${tooltipLeft}px` }">
        <div class="tooltip-title">Week of {{ shortWeek(hoveredBucket.weekStart) }}</div>
        <div v-for="tier in shownTiers" :key="tier" v-show="hoveredBucket.cleanMergeCount[tier] > 0" class="tooltip-row">
          <span class="tier-swatch" :class="`tier-${tier}`"></span>
          <span class="tooltip-label">
            {{ TIER_LABEL[tier] }} ({{ hoveredBucket.cleanMergeCount[tier] }} PR{{ hoveredBucket.cleanMergeCount[tier] === 1 ? "" : "s" }})
          </span>
          <span class="tooltip-value">{{ fmtUsd(hoveredBucket.cleanMergeCostUsd[tier] / hoveredBucket.cleanMergeCount[tier]) }}</span>
        </div>
        <div v-if="shownTiers.every((t) => hoveredBucket!.cleanMergeCount[t] === 0)" class="tooltip-row">
          <span class="tooltip-label">No cleanly merged PRs this week</span>
        </div>
      </div>
      <div class="mt-1.5 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span v-for="tier in shownTiers" :key="tier" class="flex items-center gap-1.5">
          <span class="tier-swatch" :class="`tier-${tier}`"></span>{{ TIER_LABEL[tier] }}
        </span>
      </div>
    </div>

    <details v-if="showTable" class="mt-4 text-xs" open>
      <summary class="cursor-pointer text-muted-foreground">Weekly data</summary>
      <table class="mt-2 w-full text-left text-[11px] tabular-nums">
        <thead class="text-muted-foreground">
          <tr>
            <th class="py-1 pr-2 font-medium">Week of</th>
            <th v-for="tier in TIERS" :key="tier" class="py-1 pr-2 font-medium">{{ TIER_LABEL[tier] }} spend</th>
            <th class="py-1 pr-2 font-medium">Completed</th>
            <th class="py-1 pr-2 font-medium">Failed</th>
            <th v-for="tier in TIERS" :key="`${tier}-cost`" class="py-1 pr-2 font-medium">{{ TIER_LABEL[tier] }} $/merged PR</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in buckets" :key="b.weekStart" class="border-t">
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
/*
 * Series and status colors are the validated dataviz palette (categorical
 * slots 1–3 + status good/critical), stepped per scheme. Chart chrome rides
 * the app's theme tokens so it always matches the surrounding card.
 */
.viz-root {
  --tier-base: #2a78d6;
  --tier-light: #eb6834;
  --tier-elevated: #1baf7a;
  --status-good: #0ca30c;
  --status-critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  .viz-root {
    --tier-base: #3987e5;
    --tier-light: #d95926;
    --tier-elevated: #199e70;
  }
}

.gridline {
  stroke: var(--border);
  stroke-width: 1;
}
.baseline {
  stroke: var(--border);
  stroke-width: 1;
}
.axis-label {
  fill: var(--muted-foreground);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.crosshair {
  stroke: var(--muted-foreground);
  stroke-opacity: 0.4;
  stroke-width: 1;
  stroke-dasharray: 3 3;
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
}
.tier-stroke.tier-light {
  stroke: var(--tier-light);
}
.tier-stroke.tier-elevated {
  stroke: var(--tier-elevated);
}
.tier-stroke {
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
/* End-markers carry a surface-colored ring so they stay legible on the line. */
.point-ring {
  stroke: var(--card);
  stroke-width: 2;
}
.tier-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 9999px;
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
  top: 18px;
  transform: translateX(-50%);
  background: var(--popover);
  color: var(--popover-foreground);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);
  padding: 6px 9px;
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 10;
}
.tooltip-title {
  font-weight: 600;
  margin-bottom: 3px;
}
.tooltip-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tooltip-label {
  color: var(--muted-foreground);
}
.tooltip-value {
  margin-left: auto;
  padding-left: 10px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
</style>
