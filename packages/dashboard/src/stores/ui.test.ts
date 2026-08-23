import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import type { BoardTicket } from "@fleet/shared";
import { useApprovalsStore } from "./approvals.ts";
import { useBoardStore } from "./board.ts";
import { useUiStore } from "./ui.ts";

function ticket(issueNumber: number, patch: Partial<BoardTicket> = {}): BoardTicket {
  return {
    project: "alpha",
    issueNumber,
    title: `issue ${issueNumber}`,
    url: `https://github.com/acme/alpha/issues/${issueNumber}`,
    status: "ready",
    priority: null,
    type: null,
    isPlan: false,
    ...patch,
  };
}

describe("ui store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    history.replaceState(null, "", "/");
  });
  afterEach(() => {
    history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("re-resolves the selected ticket against fresh board data", async () => {
    const board = useBoardStore();
    const ui = useUiStore();
    const stale = ticket(1, { status: "ready" });
    ui.selected = stale;

    const fresh = ticket(1, { status: "review" });
    board.tickets = [fresh];
    await nextTick();

    expect(ui.selected).toStrictEqual(fresh);
  });

  it("keeps the stale selection when the ticket left the board", async () => {
    const board = useBoardStore();
    const ui = useUiStore();
    const stale = ticket(1);
    ui.selected = stale;

    board.tickets = [ticket(2)];
    await nextTick();

    expect(ui.selected).toStrictEqual(stale);
  });

  it("opens the approvals panel when pending approvals arrive", async () => {
    const approvals = useApprovalsStore();
    const ui = useUiStore();
    expect(ui.showApprovals).toBe(false);

    approvals.approvals = [{ id: "a1", project: "alpha", issueNumber: 1 } as never];
    await nextTick();

    expect(ui.showApprovals).toBe(true);
  });

  it("restores view and filter from the URL, and resolves the ticket after the first board load", async () => {
    history.replaceState(null, "", `/?view=history&project=alpha&ticket=${encodeURIComponent("alpha:7")}`);
    const board = useBoardStore();
    const ui = useUiStore();

    expect(ui.view).toBe("history");
    expect(ui.projectFilter).toBe("alpha");
    expect(ui.selected).toBeUndefined();

    const target = ticket(7);
    board.tickets = [target];
    await nextTick();

    expect(ui.selected).toStrictEqual(target);
  });

  it("drops a URL ticket that is no longer on the board and cleans the param", async () => {
    history.replaceState(null, "", `/?ticket=${encodeURIComponent("alpha:99")}`);
    const board = useBoardStore();
    const ui = useUiStore();

    board.tickets = [ticket(1)];
    await nextTick();

    expect(ui.selected).toBeUndefined();
    expect(window.location.search).toBe("");
  });

  it("selectTicket resolves by project and issue number", () => {
    const board = useBoardStore();
    const ui = useUiStore();
    const target = ticket(3);
    board.tickets = [ticket(1), target];

    ui.selectTicket("alpha", 3);

    expect(ui.selected).toStrictEqual(target);
    expect(ui.isSelected(target)).toBe(true);
    expect(ui.isSelected(ticket(1))).toBe(false);
  });
});
