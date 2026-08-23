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
    class="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-xs"
  >
    <span class="min-w-0 shrink-0 font-medium text-foreground/80">{{ rollup.project }}</span>
    <span
      v-if="paused"
      class="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning"
    >
      paused
    </span>
    <span
      v-if="rollup.needsAttention"
      class="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 font-medium text-destructive"
      title="This dormant project has something waiting on you"
    >
      needs attention
    </span>
    <div class="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
      <span v-for="column in BOARD_COLUMNS" :key="column.status" class="whitespace-nowrap">
        {{ column.title }} <span class="font-medium text-foreground/80">{{ rollup.counts[column.status] }}</span>
      </span>
    </div>
    <button
      type="button"
      class="shrink-0 rounded-full px-1.5 py-0.5 text-warning hover:bg-warning/15 disabled:opacity-50"
      :disabled="pauseToggling"
      :title="paused ? `Resume ${rollup.project}` : `Pause ${rollup.project}`"
      @click="$emit('togglePause')"
    >
      {{ paused ? "▶" : "⏸" }}
    </button>
    <button
      type="button"
      class="shrink-0 rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
      :disabled="pinToggling"
      title="Pin this project active — expands it into the board"
      @click="$emit('activate')"
    >
      Activate
    </button>
  </div>
</template>
