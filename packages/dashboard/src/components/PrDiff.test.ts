import { mount } from "@vue/test-utils";
import type { TicketDiff } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import PrDiff from "./PrDiff.vue";

function makeDiff(patch: Partial<TicketDiff> = {}): TicketDiff {
  return {
    prUrl: "https://github.com/owner/repo/pull/1",
    files: [{ path: "a.ts", additions: 1, deletions: 1 }],
    diff: "diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context line",
    truncated: false,
    ...patch,
  };
}

describe("PrDiff", () => {
  it("colors added and removed lines distinctly", () => {
    const wrapper = mount(PrDiff, { props: { diff: makeDiff() } });
    const spans = wrapper.findAll("pre span");
    const added = spans.find((s) => s.text() === "+new line");
    const removed = spans.find((s) => s.text() === "-old line");
    const hunk = spans.find((s) => s.text() === "@@ -1,2 +1,2 @@");

    expect(added?.classes()).toContain("text-success");
    expect(removed?.classes()).toContain("text-destructive");
    expect(hunk?.classes()).toContain("text-primary");
    expect(added?.classes()).not.toEqual(removed?.classes());
  });

  it("lists files with their additions/deletions", () => {
    const wrapper = mount(PrDiff, { props: { diff: makeDiff() } });
    expect(wrapper.text()).toContain("a.ts");
    expect(wrapper.text()).toContain("+1");
    expect(wrapper.text()).toContain("-1");
  });

  it("shows an open-on-GitHub escape hatch only when truncated", () => {
    const notTruncated = mount(PrDiff, { props: { diff: makeDiff({ truncated: false }) } });
    expect(notTruncated.text()).not.toContain("open on GitHub");

    const truncated = mount(PrDiff, { props: { diff: makeDiff({ truncated: true }) } });
    expect(truncated.text()).toContain("open on GitHub");
    expect(truncated.find(`a[href="${makeDiff().prUrl}"]`).exists()).toBe(true);
  });

  it("shows an empty state for a diff with no changes", () => {
    const wrapper = mount(PrDiff, { props: { diff: makeDiff({ diff: "", files: [] }) } });
    expect(wrapper.text()).toContain("No changes.");
  });
});
