<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { BoardTicket, HistoryAggregates, HistoryRecord, HistoryWeeklyBucket } from "@fleet/shared";
import { shortModelName } from "@fleet/shared";
import { fetchHistory } from "../lib/api.ts";
import { formatCost } from "../lib/format.ts";
import HistoryCharts from "./HistoryCharts.vue";

const PAGE_SIZE = 50;

const props = defineProps<{ projectFilter?: string }>();
const emit = defineEmits<{ select: [ticket: BoardTicket] }>();

const records = ref<HistoryRecord[]>([]);
const total = ref(0);
const aggregates = ref<HistoryAggregates>();
const weeklyBuckets = ref<HistoryWeeklyBucket[]>([]);
const offset = ref(0);
const loading = ref(false);
const error = ref<string>();

async function load() {
  loading.value = true;
  try {
    const res = await fetchHistory({ project: props.projectFilter, limit: PAGE_SIZE, offset: offset.value });
    records.value = res.records;
    total.value = res.total;
    aggregates.value = res.aggregates;
    weeklyBuckets.value = res.weeklyBuckets;
    error.value = undefined;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.projectFilter,
  () => {
    offset.value = 0;
    void load();
  },
);

onMounted(() => void load());

function open(record: HistoryRecord) {
  emit("select", {
    project: record.project,
    issueNumber: record.issueNumber,
    title: record.issueTitle,
    url: record.url,
    status: "done",
    priority: null,
    type: record.ticketType ?? null,
    isPlan: record.isPlan ?? false,
    record,
  });
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function formatPct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatApprovalWait(latency: { count: number; totalWaitMs: number; maxWaitMs: number } | undefined): string {
  if (!latency || latency.count === 0) return "—";
  return `${formatDuration(latency.totalWaitMs / latency.count) || "0s"} / ${formatDuration(latency.maxWaitMs) || "0s"}`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const hasPrev = computed(() => offset.value > 0);
const hasNext = computed(() => offset.value + PAGE_SIZE < total.value);
const rangeStart = computed(() => (total.value === 0 ? 0 : offset.value + 1));
const rangeEnd = computed(() => Math.min(offset.value + PAGE_SIZE, total.value));

function prevPage() {
  if (!hasPrev.value) return;
  offset.value = Math.max(0, offset.value - PAGE_SIZE);
  void load();
}

function nextPage() {
  if (!hasNext.value) return;
  offset.value += PAGE_SIZE;
  void load();
}
</script>

<template>
  <div class="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
    <p v-if="error" class="mb-3 text-xs text-destructive">{{ error }}</p>

    <HistoryCharts :buckets="weeklyBuckets" />

    <div v-if="aggregates" class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <div class="rounded border p-2">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Tickets</div>
        <div class="text-sm font-semibold">{{ aggregates.count }}</div>
      </div>
      <div class="rounded border p-2">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Total cost</div>
        <div class="text-sm font-semibold">{{ formatCost(aggregates.totalCostUsd) || "$0.00" }}</div>
      </div>
      <div class="rounded border p-2">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Mean cost</div>
        <div class="text-sm font-semibold">{{ formatCost(aggregates.meanCostUsd) || "$0.00" }}</div>
      </div>
      <div class="rounded border p-2">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Mean duration</div>
        <div class="text-sm font-semibold">{{ formatDuration(aggregates.meanDurationMs) || "—" }}</div>
      </div>
      <div class="rounded border p-2">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Merged / Closed / None</div>
        <div class="text-sm font-semibold">
          {{ aggregates.prStateCounts.MERGED }} / {{ aggregates.prStateCounts.CLOSED }} / {{ aggregates.prStateCounts.NONE }}
        </div>
      </div>
      <div class="rounded border p-2">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Elevated / Light / Auto-resumed / Plan</div>
        <div class="text-sm font-semibold">
          {{ formatPct(aggregates.elevatedRate) }} / {{ formatPct(aggregates.lightRate) }} /
          {{ formatPct(aggregates.autoResumedRate) }} / {{ formatPct(aggregates.planRate) }}
        </div>
      </div>
      <div class="rounded border p-2">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Approval wait (mean/max)</div>
        <div class="text-sm font-semibold">{{ formatApprovalWait(aggregates.approvalLatency) }}</div>
      </div>
      <div class="rounded border p-2">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Review pass / findings / skipped</div>
        <div class="text-sm font-semibold">
          {{ aggregates.machineReviewOutcomeCounts.passed }} / {{ aggregates.machineReviewOutcomeCounts.findings }} /
          {{ aggregates.machineReviewOutcomeCounts.skipped }}
        </div>
      </div>
    </div>

    <div
      v-if="aggregates && Object.keys(aggregates.modelTotals).length > 0"
      class="mb-2 flex flex-wrap gap-2 text-xs text-muted-foreground"
    >
      <span
        v-for="(usage, model) in aggregates.modelTotals"
        :key="model"
        class="rounded border px-2 py-1"
      >
        <strong class="text-foreground/80">{{ shortModelName(String(model)) }}</strong>
        · {{ formatCost(usage.costUsd) || "<$0.01" }}
        · {{ formatTokens(usage.cacheReadTokens ?? 0) }} cache read / {{ formatTokens(usage.cacheCreationTokens ?? 0) }} write
        <template v-if="aggregates.bashDeniedByModel[model]"> · {{ aggregates.bashDeniedByModel[model] }} bash-denied</template>
      </span>
    </div>

    <p v-if="!loading && records.length === 0" class="text-xs text-muted-foreground">
      No processed tickets yet.
    </p>

    <table v-else class="w-full text-left text-xs">
      <thead class="text-muted-foreground">
        <tr>
          <th class="py-1 pr-2 font-medium">Issue</th>
          <th class="py-1 pr-2 font-medium">Project</th>
          <th class="py-1 pr-2 font-medium">Closed</th>
          <th class="py-1 pr-2 font-medium">PR</th>
          <th class="py-1 pr-2 font-medium">Cost</th>
          <th class="py-1 pr-2 font-medium">Model</th>
          <th class="py-1 pr-2 font-medium">Duration</th>
          <th class="py-1 pr-2 font-medium">Flags</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="record in records"
          :key="`${record.project}#${record.issueNumber}`"
          class="cursor-pointer border-t hover:bg-muted/50"
          @click="open(record)"
        >
          <td class="max-w-xs truncate py-1 pr-2">
            <a
              :href="record.url"
              target="_blank"
              rel="noopener"
              class="text-primary hover:underline"
              @click.stop
            >
              #{{ record.issueNumber }}
            </a>
            {{ record.issueTitle }}
          </td>
          <td class="py-1 pr-2">{{ record.project }}</td>
          <td class="py-1 pr-2">{{ new Date(record.closedAt).toLocaleString() }}</td>
          <td class="py-1 pr-2">{{ record.prState }}</td>
          <td class="py-1 pr-2">{{ formatCost(record.costUsd) }}</td>
          <td class="py-1 pr-2">{{ shortModelName(record.model) }}</td>
          <td class="py-1 pr-2">
            {{ formatDuration(new Date(record.closedAt).getTime() - new Date(record.startedAt).getTime()) }}
          </td>
          <td class="py-1 pr-2">
            <span
              v-if="record.isPlan"
              class="mr-1 rounded bg-success/15 px-1 text-success"
              >plan</span
            >
            <span
              v-if="record.elevated"
              class="mr-1 rounded bg-highlight/15 px-1 text-highlight"
              >elevated</span
            >
            <span
              v-if="record.light"
              class="mr-1 rounded bg-muted px-1 text-muted-foreground"
              >light</span
            >
            <span
              v-if="record.autoResumed"
              class="rounded bg-warning/15 px-1 text-warning"
              >auto-resumed</span
            >
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="total > 0" class="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
      <button
        type="button"
        class="rounded border px-2 py-1 disabled:opacity-40"
        :disabled="!hasPrev"
        @click="prevPage"
      >
        Prev
      </button>
      <span>{{ rangeStart }}–{{ rangeEnd }} of {{ total }}</span>
      <button
        type="button"
        class="rounded border px-2 py-1 disabled:opacity-40"
        :disabled="!hasNext"
        @click="nextPage"
      >
        Next
      </button>
    </div>
  </div>
</template>
