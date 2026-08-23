import { ref, watch } from "vue";
import { defineStore, storeToRefs } from "pinia";
import type { BoardTicket } from "@fleet/shared";
import { useUrlState } from "../composables/useUrlState.ts";
import { useApprovalsStore } from "./approvals.ts";
import { useBoardStore } from "./board.ts";

/**
 * View-layer state: current view, project filter, selected ticket, and which
 * panels are open — plus the URL sync from #204. start()/stop() are driven by
 * the app shell (they arm the popstate listener).
 */
export const useUiStore = defineStore("ui", () => {
  const view = ref<"board" | "history">("board");
  const projectFilter = ref<string>();
  const selected = ref<BoardTicket>();

  const showApprovals = ref(false);
  const showDigest = ref(false);
  const fileTicketProject = ref<string>();

  const { tickets } = storeToRefs(useBoardStore());
  const { approvals } = storeToRefs(useApprovalsStore());

  const urlState = useUrlState({ view, projectFilter, selected, tickets });

  // Re-resolve the selected ticket against fresh board data after every load —
  // previously done inline in App.vue's load().
  watch(tickets, () => {
    if (!selected.value) return;
    selected.value =
      tickets.value.find(
        (t) => t.project === selected.value?.project && t.issueNumber === selected.value?.issueNumber,
      ) ?? selected.value;
  });

  // Pending approvals pop the panel open — previously done inline in loadApprovals().
  watch(approvals, () => {
    if (approvals.value.length > 0) showApprovals.value = true;
  });

  function selectTicket(project: string, issueNumber: number) {
    const ticket = tickets.value.find((t) => t.project === project && t.issueNumber === issueNumber);
    if (ticket) selected.value = ticket;
  }

  function isSelected(ticket: BoardTicket): boolean {
    return selected.value?.project === ticket.project && selected.value?.issueNumber === ticket.issueNumber;
  }

  return {
    view,
    projectFilter,
    selected,
    showApprovals,
    showDigest,
    fileTicketProject,
    start: urlState.start,
    stop: urlState.stop,
    selectTicket,
    isSelected,
  };
});
