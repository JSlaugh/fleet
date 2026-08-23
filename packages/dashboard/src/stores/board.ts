import { ref } from "vue";
import { defineStore } from "pinia";
import type { BoardTicket, BudgetStatus, WorkHoursReserveStatus } from "@fleet/shared";
import {
  connectBoardSocket,
  fetchBoard,
  restartDaemon,
  setDaemonPaused,
  setProjectDormant,
  setProjectPaused,
  setTicketPriority,
} from "../lib/api.ts";
import { toastActionError } from "../lib/toast.ts";
import { usePolledResource } from "../composables/usePolledResource.ts";
import { useApprovalsStore } from "./approvals.ts";

/**
 * Server cache for the board plus daemon status, and every board mutation.
 * The app shell calls start()/stop(); components stay props/emits-driven and
 * never import this store.
 */
export const useBoardStore = defineStore("board", () => {
  const tickets = ref<BoardTicket[]>([]);
  const pausedUntil = ref<string>();
  const paused = ref(false);
  const pausedProjects = ref<string[]>([]);
  const dormantProjects = ref<string[]>([]);
  const runningCount = ref(0);
  const budget = ref<BudgetStatus>();
  const workHoursReserve = ref<WorkHoursReserveStatus>();
  /** Board fetch/connectivity problems only — mutation failures toast instead (#208). */
  const error = ref<string>();
  const connected = ref(false);

  const pauseToggling = ref(false);
  const restartingDaemon = ref(false);
  const projectPauseToggling = ref<string>();
  const projectPinToggling = ref<string>();

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
    } catch (err) {
      if (isStale()) return;
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  const poll = usePolledResource(load, 15000);

  let disconnect: (() => void) | undefined;

  function start() {
    poll.start();
    disconnect = connectBoardSocket(
      (type) => {
        if (type === "approvals-updated") void useApprovalsStore().refresh();
        else void poll.refresh();
      },
      (status) => (connected.value = status),
    );
  }

  function stop() {
    poll.stop();
    disconnect?.();
    disconnect = undefined;
  }

  async function setPriority(ticket: BoardTicket, priority: string | null) {
    try {
      await setTicketPriority(ticket.project, ticket.issueNumber, priority);
      await poll.refresh();
    } catch (err) {
      toastActionError(`Failed to set priority for ${ticket.project}#${ticket.issueNumber}`, err);
    }
  }

  async function togglePaused() {
    pauseToggling.value = true;
    try {
      await setDaemonPaused(!paused.value);
      await poll.refresh();
    } catch (err) {
      toastActionError(paused.value ? "Failed to resume the daemon" : "Failed to pause the daemon", err);
    } finally {
      pauseToggling.value = false;
    }
  }

  async function restartDaemonNow() {
    if (restartingDaemon.value) return;
    restartingDaemon.value = true;
    try {
      await restartDaemon();
    } catch (err) {
      toastActionError("Failed to restart the daemon", err);
    } finally {
      restartingDaemon.value = false;
    }
  }

  async function toggleProjectPaused(project: string) {
    projectPauseToggling.value = project;
    try {
      await setProjectPaused(project, !pausedProjects.value.includes(project));
      await poll.refresh();
    } catch (err) {
      toastActionError(`Failed to toggle pause for ${project}`, err);
    } finally {
      projectPauseToggling.value = undefined;
    }
  }

  async function toggleProjectDormant(project: string) {
    projectPinToggling.value = project;
    try {
      await setProjectDormant(project, !dormantProjects.value.includes(project));
      await poll.refresh();
    } catch (err) {
      toastActionError(`Failed to toggle dormant pin for ${project}`, err);
    } finally {
      projectPinToggling.value = undefined;
    }
  }

  return {
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
    refresh: poll.refresh,
    start,
    stop,
    setPriority,
    togglePaused,
    restartDaemonNow,
    toggleProjectPaused,
    toggleProjectDormant,
  };
});
