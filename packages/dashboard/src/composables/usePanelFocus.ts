import { onMounted, onUnmounted, type Ref } from "vue";

interface PanelEntry {
  close: () => void;
}

// One shared stack across every open panel: Escape closes only the topmost
// (most recently opened) one. The keydown listener is installed while at
// least one panel is open.
const stack: PanelEntry[] = [];

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  // A reka-ui dialog handles its own Escape; don't also close the panel under it.
  if (document.querySelector("[role='alertdialog'][data-state='open'], [role='dialog'][data-state='open']")) return;
  const top = stack.at(-1);
  if (!top) return;
  event.preventDefault();
  top.close();
}

/**
 * Side-panel keyboard/focus semantics without modality (the board stays
 * interactive next to the panel): on open, focus moves to the panel root; on
 * close, it returns to whatever had focus before — normally the control that
 * opened the panel; Escape closes the topmost open panel.
 *
 * The root element needs `tabindex="-1"` so it can take programmatic focus.
 */
export function usePanelFocus(root: Ref<HTMLElement | null | undefined>, close: () => void) {
  const entry: PanelEntry = { close };
  let previouslyFocused: HTMLElement | null = null;

  onMounted(() => {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (stack.length === 0) window.addEventListener("keydown", onKeydown);
    stack.push(entry);
    root.value?.focus();
  });

  onUnmounted(() => {
    const index = stack.indexOf(entry);
    if (index !== -1) stack.splice(index, 1);
    if (stack.length === 0) window.removeEventListener("keydown", onKeydown);
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
  });
}
