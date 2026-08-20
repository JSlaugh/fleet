<script setup lang="ts">
import { computed } from "vue";
import { PRIORITY_LABELS, shortModelName, type BoardTicket, type ClosedTicketRecord } from "@fleet/shared";
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

const isDone = computed(() => props.ticket.status === "done");

const closedRecord = computed(() => (isDone.value ? (props.ticket.record as ClosedTicketRecord | undefined) : undefined));

const blurb = computed(() => {
  const record = props.ticket.record;
  if (record?.sessionLive && record.lastActivityNote) return record.lastActivityNote;
  return record?.lastSummary;
});
</script>

<template>
  <article
    class="cursor-pointer rounded-lg border bg-white p-3 text-left shadow-sm transition hover:border-neutral-400 dark:bg-neutral-800 dark:hover:border-neutral-500"
    :class="[
      selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-neutral-200 dark:border-neutral-700',
      ticket.blockedBy?.length ? 'opacity-50' : '',
    ]"
    @click="emit('select')"
  >
    <div class="flex items-start gap-2">
      <h3 class="min-w-0 flex-1 text-sm font-medium text-neutral-900 dark:text-neutral-100">
        {{ ticket.title }}
      </h3>
      <select
        v-if="!isDone"
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
      v-if="blurb"
      class="mt-1.5 line-clamp-3 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400"
    >
      {{ blurb }}
    </p>
    <div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      <a
        v-if="isDone"
        :href="ticket.url"
        target="_blank"
        rel="noopener"
        class="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-600 hover:underline dark:bg-neutral-700 dark:text-neutral-300"
        @click.stop
      >
        {{ ticket.project }}#{{ ticket.issueNumber }}
      </a>
      <span v-else class="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
        {{ ticket.project }}#{{ ticket.issueNumber }}
      </span>
      <span
        v-if="ticket.type"
        class="rounded bg-indigo-100 px-1.5 py-0.5 font-medium text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
      >
        {{ ticket.type }}
      </span>
      <span
        v-if="ticket.isPlan"
        class="rounded bg-teal-100 px-1.5 py-0.5 font-medium text-teal-800 dark:bg-teal-900 dark:text-teal-200"
      >
        plan
      </span>
      <span
        v-if="ticket.epicProgress"
        class="rounded bg-teal-100 px-1.5 py-0.5 font-medium text-teal-800 dark:bg-teal-900 dark:text-teal-200"
        :title="`${ticket.epicProgress.closed} of ${ticket.epicProgress.total} child tickets closed`"
      >
        {{ ticket.epicProgress.closed }}/{{ ticket.epicProgress.total }} children
      </span>
      <span
        v-if="ticket.epicNumber"
        class="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300"
        :title="`Part of epic #${ticket.epicNumber}`"
      >
        epic #{{ ticket.epicNumber }}
      </span>
      <span
        v-if="closedRecord"
        class="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300"
      >
        {{ closedRecord.prState === "MERGED" ? "merged" : "closed" }} {{ new Date(closedRecord.closedAt).toLocaleString() }}
      </span>
      <a
        v-if="closedRecord?.prUrl"
        :href="closedRecord.prUrl"
        target="_blank"
        rel="noopener"
        class="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-800 hover:underline dark:bg-blue-900 dark:text-blue-200"
        @click.stop
      >
        PR
      </a>
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
        v-if="ticket.record?.status === 'restarting'"
        class="rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-800 dark:bg-sky-900 dark:text-sky-200"
      >
        restarting
      </span>
      <span
        v-if="ticket.record?.status === 'failed'"
        class="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-800 dark:bg-red-900 dark:text-red-200"
      >
        failed
      </span>
      <span
        v-if="ticket.blockedBy?.length"
        class="rounded bg-neutral-200 px-1.5 py-0.5 font-medium text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300"
      >
        waiting on #{{ ticket.blockedBy.join(", #") }}
      </span>
      <span
        v-if="shortModelName(ticket.record?.model)"
        class="rounded bg-violet-100 px-1.5 py-0.5 font-medium text-violet-800 dark:bg-violet-900 dark:text-violet-200"
      >
        {{ shortModelName(ticket.record?.model) }}
      </span>
      <span v-if="formatCost(ticket.record?.costUsd)" class="ml-auto text-neutral-400 dark:text-neutral-500">
        {{ formatCost(ticket.record?.costUsd) }}
      </span>
    </div>
  </article>
</template>
