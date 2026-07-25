<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { BoardTicket, TicketDetail } from "@fleet/shared";
import { fetchTicket, formatCost, formatTime } from "../lib/api.ts";

const props = defineProps<{
  ticket: BoardTicket;
}>();

const emit = defineEmits<{
  close: [];
}>();

const detail = ref<TicketDetail>();
const error = ref<string>();
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  try {
    detail.value = await fetchTicket(props.ticket.project, props.ticket.issueNumber);
    error.value = undefined;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 3000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <aside
    class="flex w-[30rem] shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900"
    aria-label="Ticket detail"
  >
    <header class="border-b border-neutral-200 p-4 dark:border-neutral-700">
      <div class="flex items-start gap-2">
        <h2 class="min-w-0 flex-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {{ ticket.title }}
        </h2>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          @click="emit('close')"
        >
          Close
        </button>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        <a :href="ticket.url" target="_blank" rel="noopener" class="text-blue-600 hover:underline dark:text-blue-400">
          {{ ticket.project }}#{{ ticket.issueNumber }}
        </a>
        <a
          v-if="detail?.record?.prUrl"
          :href="detail.record.prUrl"
          target="_blank"
          rel="noopener"
          class="text-blue-600 hover:underline dark:text-blue-400"
        >
          Pull request
        </a>
        <span v-if="detail?.record?.branch">branch {{ detail.record.branch }}</span>
        <span v-if="formatCost(detail?.record?.costUsd)">{{ formatCost(detail?.record?.costUsd) }}</span>
        <span v-if="detail?.record?.lastActivityAt">active {{ formatTime(detail.record.lastActivityAt) }}</span>
      </div>
      <p v-if="detail?.record?.lastSummary" class="mt-3 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
        {{ detail.record.lastSummary }}
      </p>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        Session transcript
      </h3>
      <p v-if="error" class="text-xs text-red-600 dark:text-red-400">{{ error }}</p>
      <p v-else-if="!detail || detail.journal.length === 0" class="text-xs text-neutral-400 dark:text-neutral-500">
        No session activity recorded yet.
      </p>
      <ol v-else class="space-y-1.5">
        <li
          v-for="(entry, index) in detail.journal"
          :key="index"
          class="rounded bg-neutral-50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
        >
          <span class="text-neutral-400 dark:text-neutral-500">{{ formatTime(entry.ts) }}</span>
          <span class="ml-2 font-semibold">{{ entry.type }}<template v-if="entry.subtype">/{{ entry.subtype }}</template></span>
          <span v-if="entry.tools?.length" class="ml-2 text-blue-700 dark:text-blue-400">{{ entry.tools.join(", ") }}</span>
          <p v-if="entry.text" class="mt-0.5 whitespace-pre-wrap break-words text-neutral-600 dark:text-neutral-400">
            {{ entry.text }}
          </p>
        </li>
      </ol>
    </div>
  </aside>
</template>
