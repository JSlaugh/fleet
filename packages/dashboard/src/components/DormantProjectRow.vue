<script setup lang="ts">
import { BOARD_COLUMNS } from "@fleet/shared";
import type { ProjectRollup } from "../lib/board.ts";

defineProps<{
  rollup: ProjectRollup;
  paused: boolean;
  pauseToggling: boolean;
  pinToggling: boolean;
}>();

defineEmits<{
  togglePause: [];
  activate: [];
}>();
</script>

<template>
  <div
    class="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900"
  >
    <span class="min-w-0 shrink-0 font-medium text-neutral-700 dark:text-neutral-200">{{ rollup.project }}</span>
    <span
      v-if="paused"
      class="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200"
    >
      paused
    </span>
    <span
      v-if="rollup.needsAttention"
      class="shrink-0 rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800 dark:bg-red-900 dark:text-red-200"
      title="This dormant project has something waiting on you"
    >
      needs attention
    </span>
    <div class="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-neutral-500 dark:text-neutral-400">
      <span v-for="column in BOARD_COLUMNS" :key="column.status" class="whitespace-nowrap">
        {{ column.title }} <span class="font-medium text-neutral-700 dark:text-neutral-200">{{ rollup.counts[column.status] }}</span>
      </span>
    </div>
    <button
      type="button"
      class="shrink-0 rounded-full px-1.5 py-0.5 text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:text-amber-300 dark:hover:bg-amber-900"
      :disabled="pauseToggling"
      :title="paused ? `Resume ${rollup.project}` : `Pause ${rollup.project}`"
      @click="$emit('togglePause')"
    >
      {{ paused ? "▶" : "⏸" }}
    </button>
    <button
      type="button"
      class="shrink-0 rounded-full bg-neutral-100 px-2.5 py-1 font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
      :disabled="pinToggling"
      title="Pin this project active — expands it into the board"
      @click="$emit('activate')"
    >
      Activate
    </button>
  </div>
</template>
