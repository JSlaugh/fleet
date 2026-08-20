import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import FileTicketPanel from "./FileTicketPanel.vue";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: { number: number; url: string }) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      url: "/api/projects/alpha/tickets",
      json: () => Promise.resolve({ ok: true, ...response }),
    } as Response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function fillRequiredSections(wrapper: ReturnType<typeof mount>) {
  await wrapper.find('input[type="text"]').setValue("Widgets don't rotate");
  const textareas = wrapper.findAll("textarea");
  await textareas[0]!.setValue("Widgets are supposed to rotate but don't.");
  await textareas[1]!.setValue("- [ ] Widgets rotate");
  await textareas[2]!.setValue("pnpm test");
}

describe("FileTicketPanel", () => {
  it("disables submit until title and all three sections are filled", async () => {
    const wrapper = mount(FileTicketPanel, { props: { project: "alpha" } });
    const submit = wrapper.find('button[type="submit"]');
    expect(submit.attributes("disabled")).toBeDefined();

    await fillRequiredSections(wrapper);
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeUndefined();
  });

  it("blocks submission and names the missing section when one is left blank", async () => {
    const wrapper = mount(FileTicketPanel, { props: { project: "alpha" } });
    await wrapper.find('input[type="text"]').setValue("Widgets don't rotate");
    const textareas = wrapper.findAll("textarea");
    await textareas[0]!.setValue("Widgets are supposed to rotate but don't.");
    await textareas[1]!.setValue("- [ ] Widgets rotate");
    // Verification left blank.

    expect(wrapper.text()).toContain("Missing: Verification");
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeDefined();
  });

  it("files the ticket through the create-ticket endpoint and shows the result", async () => {
    const fetchMock = stubFetch({ number: 42, url: "https://github.com/acme/alpha/issues/42" });
    const wrapper = mount(FileTicketPanel, { props: { project: "alpha" } });
    await fillRequiredSections(wrapper);

    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/alpha/tickets",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[0]![1];
    const body = JSON.parse(init!.body as string);
    expect(body.title).toBe("Widgets don't rotate");
    expect(body.body).toContain("## Problem");
    expect(body.body).toContain("## Acceptance criteria");
    expect(body.body).toContain("## Verification");
    expect(body.ready).toBe(true);

    expect(wrapper.text()).toContain("Filed");
    expect(wrapper.text()).toContain("#42");
    expect(wrapper.emitted("created")).toBeTruthy();
  });

  it("resets the draft when the target project changes mid-edit", async () => {
    const wrapper = mount(FileTicketPanel, { props: { project: "alpha" } });
    await fillRequiredSections(wrapper);
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeUndefined();

    await wrapper.setProps({ project: "beta" });

    expect((wrapper.find('input[type="text"]').element as HTMLInputElement).value).toBe("");
    for (const textarea of wrapper.findAll("textarea")) {
      expect((textarea.element as HTMLTextAreaElement).value).toBe("");
    }
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeDefined();
  });

  it("flags a partially-invalid depends-on list instead of silently dropping the bad token", async () => {
    const wrapper = mount(FileTicketPanel, { props: { project: "alpha" } });
    await fillRequiredSections(wrapper);

    const dependsOnInput = wrapper.findAll('input[type="text"]')[1]!;
    await dependsOnInput.setValue("12, abc");

    expect(wrapper.text()).toContain("Enter a comma-separated list of issue numbers.");
    expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeDefined();
  });
});
