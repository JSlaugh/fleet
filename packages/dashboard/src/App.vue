<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { BOARD_COLUMNS, type BoardStatus, type BoardTicket } from "@fleet/shared";
import { connectBoardSocket, fetchBoard, formatTime, setTicketPriority } from "./lib/api.ts";
import BoardColumn from "./components/BoardColumn.vue";
import TicketCard from "./components/TicketCard.vue";
import TicketDetail from "./components/TicketDetail.vue";

const tickets = ref<BoardTicket[]>([]);
const updatedAt = ref<string>();
const error = ref<string>();
const connected = ref(false);
const selected = ref<BoardTicket>();
const projectFilter = ref<string>();

let disconnect: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

const ACCENTS: Record<BoardStatus, string> = {
  ready: "bg-emerald-500",
  "in-progress": "bg-amber-500",
  "needs-input": "bg-red-500",
  review: "bg-blue-500",
};

async function load() {
  try {
    const board = await fetchBoard();
    tickets.value = board.tickets;
    updatedAt.value = board.updatedAt;
    error.value = undefined;
    if (selected.value) {
      selected.value = board.tickets.find(
        (t) => t.project === selected.value?.project && t.issueNumber === selected.value?.issueNumber,
      ) ?? selected.value;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const projects = computed(() => [...new Set(tickets.value.map((t) => t.project))].sort());

const visibleTickets = computed(() =>
  projectFilter.value ? tickets.value.filter((t) => t.project === projectFilter.value) : tickets.value,
);

const byStatus = computed(() => {
  const groups = new Map<BoardStatus, BoardTicket[]>(BOARD_COLUMNS.map((c) => [c.status, []]));
  for (const ticket of visibleTickets.value) {
    groups.get(ticket.status)?.push(ticket);
  }
  return groups;
});

async function onSetPriority(ticket: BoardTicket, priority: string | null) {
  try {
    await setTicketPriority(ticket.project, ticket.issueNumber, priority);
    ticket.priority = priority;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function isSelected(ticket: BoardTicket): boolean {
  return selected.value?.project === ticket.project && selected.value?.issueNumber === ticket.issueNumber;
}

onMounted(() => {
  void load();
  disconnect = connectBoardSocket(() => void load(), (status) => (connected.value = status));
  timer = setInterval(() => void load(), 15000);
});
onUnmounted(() => {
  disconnect?.();
  clearInterval(timer);
});
</script>

<template>
  <div class="flex h-screen flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <header class="flex items-center gap-4 border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
      <h1 class="text-base font-bold tracking-tight">Fleet</h1>
      <nav v-if="projects.length > 1" aria-label="Project filter" class="flex gap-1">
        <button
          type="button"
          class="rounded-full px-2.5 py-1 text-xs font-medium"
          :class="!projectFilter ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'"
          @click="projectFilter = undefined"
        >
          All
        </button>
        <button
          v-for="project in projects"
          :key="project"
          type="button"
          class="rounded-full px-2.5 py-1 text-xs font-medium"
          :class="projectFilter === project ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'"
          @click="projectFilter = project"
        >
          {{ project }}
        </button>
      </nav>
      <div class="ml-auto flex items-center gap-3 text-xs text-neutral-400 dark:text-neutral-500">
        <span v-if="error" class="text-red-600 dark:text-red-400">{{ error }}</span>
        <span v-if="updatedAt">updated {{ formatTime(updatedAt) }}</span>
        <span class="flex items-center gap-1.5">
          <span class="size-2 rounded-full" :class="connected ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-neutral-700'" aria-hidden="true"></span>
          {{ connected ? "live" : "offline" }}
        </span>
      </div>
    </header>

    <div class="flex min-h-0 flex-1">
      <main class="flex min-w-0 flex-1 gap-3 overflow-x-auto p-4" aria-label="Ticket board">
        <BoardColumn
          v-for="column in BOARD_COLUMNS"
          :key="column.status"
          :title="column.title"
          :count="byStatus.get(column.status)?.length ?? 0"
          :accent="ACCENTS[column.status]"
        >
          <TicketCard
            v-for="ticket in byStatus.get(column.status)"
            :key="`${ticket.project}#${ticket.issueNumber}`"
            :ticket="ticket"
            :selected="isSelected(ticket)"
            @select="selected = isSelected(ticket) ? undefined : ticket"
            @set-priority="(p) => onSetPriority(ticket, p)"
          />
        </BoardColumn>
      </main>
      <TicketDetail v-if="selected" :ticket="selected" @close="selected = undefined" />
    </div>
  </div>
</template>
