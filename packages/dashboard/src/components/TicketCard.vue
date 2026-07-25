<script setup lang="ts">
import { PRIORITY_LABELS, type BoardTicket } from "@fleet/shared";
import { formatCost } from "../lib/api.ts";

const props = defineProps<{
  ticket: BoardTicket;
  selected: boolean;
  pendingApprovals?: number;
}>();

const emit = defineEmits<{
  select: [];
  setPriority: [priority: string | null];
}>();

function onPriorityChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  emit("setPriority", value === "" ? null : value);
}

const priorityShort = (label: string) => label.replace("fleet:", "");
</script>

<template>
  <article
    class="cursor-pointer rounded-lg border bg-white p-3 text-left shadow-sm transition hover:border-neutral-400 dark:bg-neutral-800 dark:hover:border-neutral-500"
    :class="selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-neutral-200 dark:border-neutral-700'"
    @click="emit('select')"
  >
    <div class="flex items-start gap-2">
      <h3 class="min-w-0 flex-1 text-sm font-medium text-neutral-900 dark:text-neutral-100">
        {{ ticket.title }}
      </h3>
      <select
        :aria-label="`Priority for ${ticket.project} issue ${ticket.issueNumber}`"
        class="rounded border border-neutral-200 bg-neutral-50 px-1 py-0.5 text-xs text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-200"
        :value="ticket.priority ?? ''"
        @click.stop
        @change="onPriorityChange"
      >
        <option value="">—</option>
        <option v-for="p in PRIORITY_LABELS" :key="p" :value="p">{{ priorityShort(p) }}</option>
      </select>
    </div>
    <p
      v-if="ticket.record?.lastSummary"
      class="mt-1.5 line-clamp-3 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400"
    >
      {{ ticket.record.lastSummary }}
    </p>
    <div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      <span class="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
        {{ ticket.project }}#{{ ticket.issueNumber }}
      </span>
      <span
        v-if="ticket.record?.sessionLive"
        class="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
      >
        live
      </span>
      <span
        v-if="pendingApprovals"
        class="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200"
      >
        {{ pendingApprovals }} approval{{ pendingApprovals === 1 ? "" : "s" }}
      </span>
      <span
        v-if="ticket.record?.status === 'stalled'"
        class="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200"
      >
        stalled
      </span>
      <span
        v-if="ticket.record?.status === 'failed'"
        class="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-800 dark:bg-red-900 dark:text-red-200"
      >
        failed
      </span>
      <span v-if="formatCost(ticket.record?.costUsd)" class="ml-auto text-neutral-400 dark:text-neutral-500">
        {{ formatCost(ticket.record?.costUsd) }}
      </span>
    </div>
  </article>
</template>
