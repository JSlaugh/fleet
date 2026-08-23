import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { usePanelFocus } from "./usePanelFocus.ts";

function mountPanel(close: () => void): VueWrapper {
  return mount(
    defineComponent({
      setup() {
        const root = ref<HTMLElement>();
        usePanelFocus(root, close);
        return () => h("aside", { ref: root, tabindex: "-1" });
      },
    }),
    { attachTo: document.body },
  );
}

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

describe("usePanelFocus", () => {
  const wrappers: VueWrapper[] = [];
  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount();
    document.body.innerHTML = "";
  });

  it("moves focus into the panel on open and back to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const wrapper = mountPanel(vi.fn());
    expect(document.activeElement).toBe(wrapper.element);

    wrapper.unmount();
    expect(document.activeElement).toBe(opener);
  });

  it("Escape closes only the topmost open panel", () => {
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    wrappers.push(mountPanel(closeFirst), mountPanel(closeSecond));

    pressEscape();

    expect(closeSecond).toHaveBeenCalledTimes(1);
    expect(closeFirst).not.toHaveBeenCalled();
  });

  it("closes the next panel down once the top one is gone", () => {
    const closeFirst = vi.fn();
    wrappers.push(mountPanel(closeFirst));
    const top = mountPanel(vi.fn());
    top.unmount();

    pressEscape();

    expect(closeFirst).toHaveBeenCalledTimes(1);
  });

  it("ignores an Escape someone else already handled", () => {
    const close = vi.fn();
    wrappers.push(mountPanel(close));

    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    Object.defineProperty(event, "defaultPrevented", { value: true });
    window.dispatchEvent(event);

    expect(close).not.toHaveBeenCalled();
  });

  it("does nothing once every panel is closed", () => {
    const close = vi.fn();
    const wrapper = mountPanel(close);
    wrapper.unmount();

    const event = pressEscape();

    expect(close).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
