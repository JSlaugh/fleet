import { getCurrentInstance, onMounted, onUnmounted, watch, type Ref } from "vue";
import type { BoardTicket } from "@fleet/shared";
import { parseUrlState, serializeUrlState, type UrlTicketRef } from "../lib/urlState.ts";

interface UrlStateRefs {
  view: Ref<"board" | "history">;
  projectFilter: Ref<string | undefined>;
  selected: Ref<BoardTicket | undefined>;
  tickets: Ref<BoardTicket[]>;
}

/**
 * Two-way sync of view/filter/selection with the URL query string, via
 * history.replaceState (no router, no history entries of our own).
 *
 * The selected ticket serializes as project + issueNumber; restoring it has to
 * wait for board data, so the parsed ref is parked in `pendingTicket` and
 * resolved on the next tickets update — the same board load after which App.vue
 * re-resolves `selected`. A ref that's no longer on the board is dropped then,
 * and the URL param cleared with it.
 */
export function useUrlState({ view, projectFilter, selected, tickets }: UrlStateRefs) {
  let pendingTicket: UrlTicketRef | undefined;

  function findTicket(target: UrlTicketRef): BoardTicket | undefined {
    return tickets.value.find((t) => t.project === target.project && t.issueNumber === target.issueNumber);
  }

  function syncUrl() {
    const ticket = selected.value
      ? { project: selected.value.project, issueNumber: selected.value.issueNumber }
      : pendingTicket;
    const target = `${window.location.pathname}${serializeUrlState({ view: view.value, project: projectFilter.value, ticket })}`;
    if (`${window.location.pathname}${window.location.search}` !== target) {
      history.replaceState(history.state, "", target);
    }
  }

  function applyFromLocation() {
    const state = parseUrlState(window.location.search);
    view.value = state.view;
    projectFilter.value = state.project;
    if (!state.ticket) {
      pendingTicket = undefined;
      selected.value = undefined;
      return;
    }
    const match = findTicket(state.ticket);
    pendingTicket = match ? undefined : state.ticket;
    selected.value = match;
  }

  applyFromLocation();

  watch(tickets, () => {
    if (!pendingTicket) return;
    const match = findTicket(pendingTicket);
    if (match) selected.value = match;
    pendingTicket = undefined;
    syncUrl();
  });

  watch([view, projectFilter, selected], syncUrl);

  const onPopState = () => applyFromLocation();
  const start = () => window.addEventListener("popstate", onPopState);
  const stop = () => window.removeEventListener("popstate", onPopState);

  // Inside a component the popstate listener rides mount/unmount; inside a
  // Pinia store the caller drives start/stop from the app shell.
  if (getCurrentInstance()) {
    onMounted(start);
    onUnmounted(stop);
  }

  return { start, stop };
}
