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
  resolveApproval,
  restartDaemon,
  setDaemonPaused,
  setProjectDormant,
  setProjectPaused,
  setTicketPriority,
} from "./lib/api.ts";
import { buildAttentionQueue, groupByEpic, projectRollup } from "./lib/board.ts";
import { formatCost } from "./lib/format.ts";
import { budgetGateClass, STATUS_ACCENTS } from "./lib/statusColors.ts";
import { usePolledResource } from "./composables/usePolledResource.ts";
import { useUrlState } from "./composables/useUrlState.ts";
import ApprovalsPanel from "./components/ApprovalsPanel.vue";
import AttentionQueue from "./components/AttentionQueue.vue";
import BoardColumn from "./components/BoardColumn.vue";
import DigestPanel from "./components/DigestPanel.vue";
import DormantProjectRow from "./components/DormantProjectRow.vue";
import FileTicketPanel from "./components/FileTicketPanel.vue";
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
const dormantProjects = ref<string[]>([]);
const runningCount = ref(0);
const budget = ref<BudgetStatus>();
const workHoursReserve = ref<WorkHoursReserveStatus>();
const pauseToggling = ref(false);
const restartingDaemon = ref(false);
const projectPauseToggling = ref<string>();
const projectPinToggling = ref<string>();
const fileTicketProject = ref<string>();
const error = ref<string>();
const approvalsError = ref<string>();
const connected = ref(false);
const selected = ref<BoardTicket>();
const projectFilter = ref<string>();

useUrlState({ view, projectFilter, selected, tickets });

let disconnect: (() => void) | undefined;

async function load(isStale: () => boolean) {
  try {
    const board = await fetchBoard();
    if (isStale()) return;
    tickets.value = board.tickets;
    pausedUntil.value = board.pausedUntil;
    paused.value = board.paused;
    pausedProjects.value = board.pausedProjects;
    dormantProjects.value = board.dormantProjects;
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
    if (isStale()) return;
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const { refresh: refreshBoard } = usePolledResource(load, 15000);

const projects = computed(() => [...new Set(tickets.value.map((t) => t.project))].sort());

const totalCost = computed(() => {
  const sum = visibleTickets.value.reduce((acc, t) => acc + (t.record?.costUsd ?? 0), 0);
  return formatCost(sum);
});

// A project filter is an explicit "look at this one" — it bypasses the dormant
// collapse below so a pinned-dormant project can still be inspected directly.
// Unfiltered ("All"), dormant projects' tickets are pulled out of the shared
// board entirely and surface only via their rollup row instead.
const visibleTickets = computed(() => {
  if (projectFilter.value) return tickets.value.filter((t) => t.project === projectFilter.value);
  return tickets.value.filter((t) => !dormantProjects.value.includes(t.project));
});

const byStatus = computed(() => {
  const groups = new Map<BoardStatus, BoardTicket[]>(BOARD_COLUMNS.map((c) => [c.status, []]));
  for (const ticket of visibleTickets.value) {
    groups.get(ticket.status)?.push(ticket);
  }
  for (const [status, list] of groups) groups.set(status, groupByEpic(list));
  return groups;
});

/** Rollup rows for dormant projects — hidden once a project filter narrows the view to one project. */
const dormantRollups = computed(() => {
  if (projectFilter.value) return [];
  return dormantProjects.value.map((project) =>
    projectRollup(project, tickets.value, approvals.value.filter((a) => a.project === project).length),
  );
});

/**
 * The cross-project "needs me" queue (#161): built from the unfiltered ticket
 * and approval lists so dormant projects' items still surface — that's the
 * whole point of collapsing them safely — narrowed only by an explicit
 * project filter, same as every other board surface.
 */
const attentionItems = computed(() => {
  const scopedTickets = projectFilter.value ? tickets.value.filter((t) => t.project === projectFilter.value) : tickets.value;
  const scopedApprovals = projectFilter.value ? approvals.value.filter((a) => a.project === projectFilter.value) : approvals.value;
  return buildAttentionQueue(scopedTickets, scopedApprovals, Date.now());
});

function onAttentionSelect(project: string, issueNumber: number) {
  const ticket = tickets.value.find((t) => t.project === project && t.issueNumber === issueNumber);
  if (ticket) selected.value = ticket;
}

async function loadApprovals(isStale: () => boolean) {
  try {
    const fetched = (await fetchApprovals()).approvals;
    if (isStale()) return;
    approvals.value = fetched;
    if (approvals.value.length > 0) showApprovals.value = true;
    approvalsError.value = undefined;
  } catch (err) {
    if (isStale()) return;
    approvalsError.value = err instanceof Error ? err.message : String(err);
  }
}

const { refresh: refreshApprovals } = usePolledResource(loadApprovals, 15000);

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
    await refreshApprovals();
    done?.(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    done?.(false);
  }
}

async function onSetPriority(ticket: BoardTicket, priority: string | null) {
  try {
    await setTicketPriority(ticket.project, ticket.issueNumber, priority);
    await refreshBoard();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function togglePaused() {
  pauseToggling.value = true;
  try {
    await setDaemonPaused(!paused.value);
    await refreshBoard();
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
    await refreshBoard();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    projectPauseToggling.value = undefined;
  }
}

async function toggleProjectDormant(project: string) {
  projectPinToggling.value = project;
  try {
    await setProjectDormant(project, !dormantProjects.value.includes(project));
    await refreshBoard();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    projectPinToggling.value = undefined;
  }
}

const budgetClass = computed(() => budgetGateClass(budget.value?.gate));

function isSelected(ticket: BoardTicket): boolean {
  return selected.value?.project === ticket.project && selected.value?.issueNumber === ticket.issueNumber;
}

onMounted(() => {
  disconnect = connectBoardSocket(
    (type) => {
      if (type === "approvals-updated") void refreshApprovals();
      else void refreshBoard();
    },
    (status) => (connected.value = status),
  );
});
onUnmounted(() => {
  disconnect?.();
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
          :class="pausedProjects.includes(project) ? 'bg-amber-50 dark:bg-amber-950' : dormantProjects.includes(project) ? 'bg-neutral-100 dark:bg-neutral-900' : ''"
        >
          <button
            type="button"
            class="px-2.5 py-1 text-xs font-medium"
            :class="
              projectFilter === project
                ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                : pausedProjects.includes(project)
                  ? 'text-amber-800 dark:text-amber-200'
                  : dormantProjects.includes(project)
                    ? 'text-neutral-400 dark:text-neutral-500'
                    : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
            "
            @click="projectFilter = project"
          >
            {{ project }}<template v-if="pausedProjects.includes(project)"> · paused</template><template v-if="dormantProjects.includes(project)"> · dormant</template>
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
          <button
            type="button"
            class="px-1.5 py-1 text-xs text-neutral-500 hover:bg-neutral-200 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-700"
            :disabled="projectPinToggling === project"
            :title="dormantProjects.includes(project) ? `Pin ${project} active` : `Pin ${project} dormant`"
            @click="toggleProjectDormant(project)"
          >
            {{ dormantProjects.includes(project) ? "○" : "●" }}
          </button>
          <button
            type="button"
            class="px-1.5 py-1 text-xs text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
            :title="`File a ticket in ${project}`"
            @click="fileTicketProject = project"
          >
            +
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
      <main v-if="view === 'board'" class="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-4" aria-label="Ticket board">
        <AttentionQueue
          v-if="attentionItems.length > 0"
          :items="attentionItems"
          @select="onAttentionSelect"
          @open-approvals="showApprovals = true"
        />
        <div v-if="dormantRollups.length > 0" class="flex shrink-0 flex-col gap-1.5" aria-label="Dormant projects">
          <DormantProjectRow
            v-for="rollup in dormantRollups"
            :key="rollup.project"
            :rollup="rollup"
            :paused="pausedProjects.includes(rollup.project)"
            :pause-toggling="projectPauseToggling === rollup.project"
            :pin-toggling="projectPinToggling === rollup.project"
            @toggle-pause="toggleProjectPaused(rollup.project)"
            @activate="toggleProjectDormant(rollup.project)"
          />
        </div>
        <div class="flex min-h-0 flex-1 gap-3 overflow-x-auto">
          <BoardColumn
            v-for="column in BOARD_COLUMNS"
            :key="column.status"
            :title="column.title"
            :count="byStatus.get(column.status)?.length ?? 0"
            :accent="STATUS_ACCENTS[column.status]"
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
        </div>
      </main>
      <HistoryView v-else :project-filter="projectFilter" @select="selected = $event" />
      <TicketDetail v-if="selected" :ticket="selected" @close="selected = undefined" />
      <FileTicketPanel
        v-if="fileTicketProject"
        :project="fileTicketProject"
        @close="fileTicketProject = undefined"
        @created="refreshBoard"
      />
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
