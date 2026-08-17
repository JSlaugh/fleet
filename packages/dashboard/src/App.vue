<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  BOARD_COLUMNS,
  type BoardStatus,
  type BoardTicket,
  type BudgetStatus,
  type PendingApproval,
  type WorkHoursReserveStatus,
} from "@fleet/shared";
import {
  connectBoardSocket,
  fetchApprovals,
  fetchBoard,
  formatCost,
  resolveApproval,
  restartDaemon,
  setDaemonPaused,
  setProjectPaused,
  setTicketPriority,
} from "./lib/api.ts";
import ApprovalsPanel from "./components/ApprovalsPanel.vue";
import BoardColumn from "./components/BoardColumn.vue";
import DigestPanel from "./components/DigestPanel.vue";
import HistoryView from "./components/HistoryView.vue";
import TicketCard from "./components/TicketCard.vue";
import TicketDetail from "./components/TicketDetail.vue";

const tickets = ref<BoardTicket[]>([]);
const approvals = ref<PendingApproval[]>([]);
const showApprovals = ref(false);
const showDigest = ref(false);
const view = ref<"board" | "history">("board");
const pausedUntil = ref<string>();
const paused = ref(false);
const pausedProjects = ref<string[]>([]);
const runningCount = ref(0);
const budget = ref<BudgetStatus>();
const workHoursReserve = ref<WorkHoursReserveStatus>();
const pauseToggling = ref(false);
const restartingDaemon = ref(false);
const projectPauseToggling = ref<string>();
const error = ref<string>();
const approvalsError = ref<string>();
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
  done: "bg-neutral-400",
};

async function load() {
  try {
    const board = await fetchBoard();
    tickets.value = board.tickets;
    pausedUntil.value = board.pausedUntil;
    paused.value = board.paused;
    pausedProjects.value = board.pausedProjects;
    runningCount.value = board.runningCount;
    budget.value = board.budget;
    workHoursReserve.value = board.workHoursReserve;
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

const totalCost = computed(() => {
  const sum = visibleTickets.value.reduce((acc, t) => acc + (t.record?.costUsd ?? 0), 0);
  return formatCost(sum);
});

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

async function loadApprovals() {
  try {
    approvals.value = (await fetchApprovals()).approvals;
    if (approvals.value.length > 0) showApprovals.value = true;
    approvalsError.value = undefined;
  } catch (err) {
    approvalsError.value = err instanceof Error ? err.message : String(err);
  }
}

const approvalCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const approval of approvals.value) {
    const key = `${approval.project}#${approval.issueNumber}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
});

async function onResolveApproval(
  id: string,
  decision: "allow" | "deny" | "answer",
  message?: string,
  done?: (ok: boolean) => void,
) {
  try {
    await resolveApproval(id, decision, message);
    await loadApprovals();
    done?.(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    done?.(false);
  }
}

async function onSetPriority(ticket: BoardTicket, priority: string | null) {
  try {
    await setTicketPriority(ticket.project, ticket.issueNumber, priority);
    ticket.priority = priority;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function togglePaused() {
  pauseToggling.value = true;
  try {
    await setDaemonPaused(!paused.value);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    pauseToggling.value = false;
  }
}

async function confirmRestartDaemon() {
  if (restartingDaemon.value) return;
  const confirmed = window.confirm(
    [
      "Restart the fleet daemon?",
      "",
      `This aborts ${runningCount.value} running ticket${runningCount.value === 1 ? "" : "s"} mid-turn and exits the process for a supervisor to relaunch.`,
      "Interrupted tickets auto-resume from their last session on the next boot.",
    ].join("\n"),
  );
  if (!confirmed) return;
  restartingDaemon.value = true;
  try {
    await restartDaemon();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    restartingDaemon.value = false;
  }
}

async function toggleProjectPaused(project: string) {
  projectPauseToggling.value = project;
  try {
    await setProjectPaused(project, !pausedProjects.value.includes(project));
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    projectPauseToggling.value = undefined;
  }
}

const budgetClass = computed(() => {
  switch (budget.value?.gate) {
    case "blocked":
      return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200";
    case "light-only":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200";
    default:
      return "text-neutral-500";
  }
});

function isSelected(ticket: BoardTicket): boolean {
  return selected.value?.project === ticket.project && selected.value?.issueNumber === ticket.issueNumber;
}

onMounted(() => {
  void load();
  void loadApprovals();
  disconnect = connectBoardSocket(
    (type) => {
      if (type === "approvals-updated") void loadApprovals();
      else void load();
    },
    (status) => (connected.value = status),
  );
  timer = setInterval(() => {
    void load();
    void loadApprovals();
  }, 15000);
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
      <nav v-if="projects.length > 0" aria-label="Project filter" class="flex flex-wrap items-center gap-1">
        <button
          v-if="projects.length > 1"
          type="button"
          class="rounded-full px-2.5 py-1 text-xs font-medium"
          :class="!projectFilter ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'"
          @click="projectFilter = undefined"
        >
          All
        </button>
        <span
          v-for="project in projects"
          :key="project"
          class="flex items-center overflow-hidden rounded-full"
          :class="pausedProjects.includes(project) ? 'bg-amber-50 dark:bg-amber-950' : ''"
        >
          <button
            type="button"
            class="px-2.5 py-1 text-xs font-medium"
            :class="
              projectFilter === project
                ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                : pausedProjects.includes(project)
                  ? 'text-amber-800 dark:text-amber-200'
                  : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
            "
            @click="projectFilter = project"
          >
            {{ project }}<template v-if="pausedProjects.includes(project)"> · paused</template>
          </button>
          <button
            type="button"
            class="px-1.5 py-1 text-xs text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:text-amber-300 dark:hover:bg-amber-900"
            :disabled="projectPauseToggling === project"
            :title="pausedProjects.includes(project) ? `Resume ${project}` : `Pause ${project}`"
            @click="toggleProjectPaused(project)"
          >
            {{ pausedProjects.includes(project) ? "▶" : "⏸" }}
          </button>
        </span>
      </nav>
      <button
        type="button"
        class="ml-auto rounded-full px-2.5 py-1 text-xs font-medium"
        :class="view === 'history' ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'"
        @click="view = view === 'board' ? 'history' : 'board'"
      >
        {{ view === "board" ? "History" : "Board" }}
      </button>
      <span
        v-if="budget"
        class="rounded-full px-2.5 py-1 text-xs font-medium"
        :class="budgetClass"
        :title="`Self-estimated spend over the trailing ${budget.windowHours}h vs configured budget`"
      >
        ${{ budget.spentUsd.toFixed(2) }} / ${{ budget.budgetUsd.toFixed(2) }} ({{ budget.windowHours }}h)
      </span>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
        :class="paused ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'"
        :disabled="pauseToggling"
        @click="togglePaused"
      >
        {{ paused ? "Resume" : "Pause" }}
      </button>
      <button
        type="button"
        class="rounded-full border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
        :disabled="restartingDaemon"
        title="Abort live sessions and exit for a supervisor to relaunch — interrupted tickets auto-resume on the next boot"
        @click="confirmRestartDaemon"
      >
        {{ restartingDaemon ? "Restarting…" : "Restart daemon" }}
      </button>
      <button
        type="button"
        class="rounded-full px-2.5 py-1 text-xs font-medium"
        :class="showDigest ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'"
        @click="showDigest = !showDigest"
      >
        Digest
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
        :class="approvals.length > 0 ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'"
        @click="showApprovals = !showApprovals"
      >
        Approvals
        <span v-if="approvals.length > 0" class="rounded-full bg-amber-500 px-1.5 text-white">{{ approvals.length }}</span>
      </button>
      <div class="flex items-center gap-3 text-xs text-neutral-400 dark:text-neutral-500">
        <span v-if="error" class="text-red-600 dark:text-red-400">{{ error }}</span>
        <span v-if="approvalsError" class="text-amber-600 dark:text-amber-400" :title="approvalsError">approvals unavailable</span>
        <span v-if="totalCost" :title="'Total cost of tickets on the board'">Σ {{ totalCost }}</span>
        <span class="flex items-center gap-1.5">
          <span class="size-2 rounded-full" :class="connected ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-neutral-700'" aria-hidden="true"></span>
          {{ connected ? "live" : "offline" }}
        </span>
      </div>
    </header>

    <div
      v-if="paused"
      class="border-b border-amber-200 bg-amber-50 px-5 py-2 text-center text-xs font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      Paused — finishing {{ runningCount }} running ticket{{ runningCount === 1 ? "" : "s" }}, no new claims
    </div>
    <div
      v-if="pausedUntil"
      class="border-b border-amber-200 bg-amber-50 px-5 py-2 text-center text-xs font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      Plan limit reached — paused until {{ new Date(pausedUntil).toLocaleString() }}
    </div>
    <div
      v-if="workHoursReserve?.active"
      class="border-b border-amber-200 bg-amber-50 px-5 py-2 text-center text-xs font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      Work-hours reserve — claims held until
      {{ workHoursReserve.releaseAt ? new Date(workHoursReserve.releaseAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "" }}
    </div>

    <div class="flex min-h-0 flex-1">
      <main v-if="view === 'board'" class="flex min-w-0 flex-1 gap-3 overflow-x-auto p-4" aria-label="Ticket board">
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
            :pending-approvals="approvalCounts.get(`${ticket.project}#${ticket.issueNumber}`) ?? 0"
            @select="selected = isSelected(ticket) ? undefined : ticket"
            @set-priority="(p) => onSetPriority(ticket, p)"
          />
        </BoardColumn>
      </main>
      <HistoryView v-else :project-filter="projectFilter" @select="selected = $event" />
      <TicketDetail v-if="selected" :ticket="selected" @close="selected = undefined" />
      <DigestPanel v-if="showDigest" @close="showDigest = false" />
      <ApprovalsPanel
        v-if="showApprovals"
        :approvals="approvals"
        @resolve="onResolveApproval"
        @close="showApprovals = false"
      />
    </div>
  </div>
</template>
