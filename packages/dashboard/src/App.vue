<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { BOARD_COLUMNS, type BoardStatus, type BoardTicket } from "@fleet/shared";
import { buildAttentionQueue, groupByEpic, projectRollup } from "./lib/board.ts";
import { formatCost } from "./lib/format.ts";
import { budgetGateClass, STATUS_ACCENTS } from "./lib/statusColors.ts";
import { useApprovalsStore } from "./stores/approvals.ts";
import { useBoardStore } from "./stores/board.ts";
import { useUiStore } from "./stores/ui.ts";
import { Toaster } from "@/components/ui/sonner/index.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog/index.ts";
import ApprovalsPanel from "./components/ApprovalsPanel.vue";
import AttentionQueue from "./components/AttentionQueue.vue";
import BoardColumn from "./components/BoardColumn.vue";
import DigestPanel from "./components/DigestPanel.vue";
import DormantProjectRow from "./components/DormantProjectRow.vue";
import FileTicketPanel from "./components/FileTicketPanel.vue";
import HistoryView from "./components/HistoryView.vue";
import TicketCard from "./components/TicketCard.vue";
import TicketDetail from "./components/TicketDetail.vue";

// State and mutations live in the Pinia stores (#209); this component is
// layout plus presentation-only derivations. Leaf components stay
// props/emits-driven — the stores are consumed here only.
const board = useBoardStore();
const approvalsStore = useApprovalsStore();
const ui = useUiStore();

const {
  tickets,
  pausedUntil,
  paused,
  pausedProjects,
  dormantProjects,
  runningCount,
  budget,
  workHoursReserve,
  error,
  connected,
  pauseToggling,
  restartingDaemon,
  projectPauseToggling,
  projectPinToggling,
} = storeToRefs(board);
const { approvals, approvalsError } = storeToRefs(approvalsStore);
const { view, projectFilter, selected, showApprovals, showDigest, fileTicketProject } = storeToRefs(ui);

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

const approvalCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const approval of approvals.value) {
    const key = `${approval.project}#${approval.issueNumber}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
});

const budgetClass = computed(() => budgetGateClass(budget.value?.gate));

onMounted(() => {
  board.start();
  approvalsStore.start();
  ui.start();
});
onUnmounted(() => {
  board.stop();
  approvalsStore.stop();
  ui.stop();
});
</script>

<template>
  <div class="flex h-screen flex-col bg-background text-foreground">
    <Toaster theme="system" position="bottom-right" close-button />
    <header class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-3">
      <h1 class="text-base font-bold tracking-tight">Fleet</h1>
      <nav v-if="projects.length > 0" aria-label="Project filter" class="flex flex-wrap items-center gap-1">
        <button
          v-if="projects.length > 1"
          type="button"
          class="rounded-full px-2.5 py-1 text-xs font-medium"
          :class="!projectFilter ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent'"
          @click="projectFilter = undefined"
        >
          All
        </button>
        <span
          v-for="project in projects"
          :key="project"
          class="flex items-center overflow-hidden rounded-full"
          :class="pausedProjects.includes(project) ? 'bg-warning/10' : dormantProjects.includes(project) ? 'bg-muted' : ''"
        >
          <button
            type="button"
            class="px-2.5 py-1 text-xs font-medium"
            :class="
              projectFilter === project
                ? 'bg-foreground text-background'
                : pausedProjects.includes(project)
                  ? 'text-warning'
                  : dormantProjects.includes(project)
                    ? 'text-muted-foreground'
                    : 'text-muted-foreground hover:bg-accent'
            "
            @click="projectFilter = project"
          >
            {{ project }}<template v-if="pausedProjects.includes(project)"> · paused</template><template v-if="dormantProjects.includes(project)"> · dormant</template>
          </button>
          <button
            type="button"
            class="px-1.5 py-1 text-xs text-warning hover:bg-warning/15 disabled:opacity-50"
            :disabled="projectPauseToggling === project"
            :title="pausedProjects.includes(project) ? `Resume ${project}` : `Pause ${project}`"
            @click="board.toggleProjectPaused(project)"
          >
            {{ pausedProjects.includes(project) ? "▶" : "⏸" }}
          </button>
          <button
            type="button"
            class="px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            :disabled="projectPinToggling === project"
            :title="dormantProjects.includes(project) ? `Pin ${project} active` : `Pin ${project} dormant`"
            @click="board.toggleProjectDormant(project)"
          >
            {{ dormantProjects.includes(project) ? "○" : "●" }}
          </button>
          <button
            type="button"
            class="px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent"
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
        :class="view === 'history' ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent'"
        @click="view = view === 'board' ? 'history' : 'board'"
      >
        {{ view === "board" ? "History" : "Board" }}
      </button>
      <span
        v-if="budget"
        class="whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium"
        :class="budgetClass"
        :title="`Self-estimated spend over the trailing ${budget.windowHours}h vs configured budget`"
      >
        ${{ budget.spentUsd.toFixed(2) }} / ${{ budget.budgetUsd.toFixed(2) }} ({{ budget.windowHours }}h)
      </span>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
        :class="paused ? 'bg-warning/15 text-warning' : 'text-muted-foreground hover:bg-accent'"
        :disabled="pauseToggling"
        @click="board.togglePaused"
      >
        {{ paused ? "Resume" : "Pause" }}
      </button>
      <AlertDialog>
        <AlertDialogTrigger as-child>
          <button
            type="button"
            class="rounded-full border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            :disabled="restartingDaemon"
            title="Abort live sessions and exit for a supervisor to relaunch — interrupted tickets auto-resume on the next boot"
          >
            {{ restartingDaemon ? "Restarting…" : "Restart daemon" }}
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart the fleet daemon?</AlertDialogTitle>
            <AlertDialogDescription>
              This aborts {{ runningCount }} running ticket{{ runningCount === 1 ? "" : "s" }} mid-turn and exits the
              process for a supervisor to relaunch. Interrupted tickets auto-resume from their last session on the
              next boot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction @click="board.restartDaemonNow">Restart daemon</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <button
        type="button"
        class="rounded-full px-2.5 py-1 text-xs font-medium"
        :class="showDigest ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent'"
        @click="showDigest = !showDigest"
      >
        Digest
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
        :class="approvals.length > 0 ? 'bg-warning/15 text-warning' : 'text-muted-foreground hover:bg-accent'"
        @click="showApprovals = !showApprovals"
      >
        Approvals
        <span v-if="approvals.length > 0" class="rounded-full bg-warning px-1.5 text-background">{{ approvals.length }}</span>
      </button>
      <div class="flex items-center gap-3 text-xs text-muted-foreground">
        <span v-if="error" class="text-destructive">{{ error }}</span>
        <span v-if="approvalsError" class="text-warning" :title="approvalsError">approvals unavailable</span>
        <span v-if="totalCost" :title="'Total cost of tickets on the board'">Σ {{ totalCost }}</span>
        <span class="flex items-center gap-1.5">
          <span class="size-2 rounded-full" :class="connected ? 'bg-success' : 'bg-muted-foreground/40'" aria-hidden="true"></span>
          {{ connected ? "live" : "offline" }}
        </span>
      </div>
    </header>

    <div
      v-if="paused"
      class="border-b border-warning/30 bg-warning/10 px-5 py-2 text-center text-xs font-medium text-warning"
    >
      Paused — finishing {{ runningCount }} running ticket{{ runningCount === 1 ? "" : "s" }}, no new claims
    </div>
    <div
      v-if="pausedUntil"
      class="border-b border-warning/30 bg-warning/10 px-5 py-2 text-center text-xs font-medium text-warning"
    >
      Plan limit reached — paused until {{ new Date(pausedUntil).toLocaleString() }}
    </div>
    <div
      v-if="workHoursReserve?.active"
      class="border-b border-warning/30 bg-warning/10 px-5 py-2 text-center text-xs font-medium text-warning"
    >
      Work-hours reserve — claims held until
      {{ workHoursReserve.releaseAt ? new Date(workHoursReserve.releaseAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "" }}
    </div>

    <div class="flex min-h-0 flex-1">
      <main v-if="view === 'board'" class="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-4" aria-label="Ticket board">
        <AttentionQueue
          v-if="attentionItems.length > 0"
          :items="attentionItems"
          @select="ui.selectTicket"
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
            @toggle-pause="board.toggleProjectPaused(rollup.project)"
            @activate="board.toggleProjectDormant(rollup.project)"
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
              :selected="ui.isSelected(ticket)"
              :pending-approvals="approvalCounts.get(`${ticket.project}#${ticket.issueNumber}`) ?? 0"
              @select="selected = ui.isSelected(ticket) ? undefined : ticket"
              @set-priority="(p) => board.setPriority(ticket, p)"
              @mark-ready="board.markReady(ticket)"
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
        @created="board.refresh"
      />
      <DigestPanel v-if="showDigest" @close="showDigest = false" />
      <ApprovalsPanel
        v-if="showApprovals"
        :approvals="approvals"
        @resolve="approvalsStore.resolve"
        @close="showApprovals = false"
      />
    </div>
  </div>
</template>
