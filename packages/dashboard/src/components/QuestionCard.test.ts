import { mount } from "@vue/test-utils";
import type { PendingApproval } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import QuestionCard from "./QuestionCard.vue";

function makeApproval(): PendingApproval {
  return {
    id: "approval-1",
    project: "owner/repo",
    issueNumber: 7,
    toolName: "AskUserQuestion",
    kind: "question",
    createdAt: "2026-01-01T00:00:00Z",
    input: {
      questions: [
        {
          question: "Which approach?",
          options: [{ label: "Approach A" }, { label: "Approach B", description: "the safer one" }],
        },
      ],
    },
  };
}

describe("QuestionCard", () => {
  it("renders the question's options", () => {
    const wrapper = mount(QuestionCard, { props: { approval: makeApproval() } });
    const labels = wrapper.findAll("label").map((label) => label.text());
    expect(labels.some((text) => text.includes("Approach A"))).toBe(true);
    expect(labels.some((text) => text.includes("Approach B") && text.includes("the safer one"))).toBe(true);
  });

  it("emits the chosen answer when an option is picked and submitted", async () => {
    const wrapper = mount(QuestionCard, { props: { approval: makeApproval() } });

    const radios = wrapper.findAll('input[type="radio"]');
    expect(radios).toHaveLength(2);
    await radios[1]!.setValue(true);

    await wrapper.find("button").trigger("click");

    const emitted = wrapper.emitted("answer");
    expect(emitted).toHaveLength(1);
    const [message] = emitted![0]!;
    expect(message).toContain("Which approach?");
    expect(message).toContain("Approach B");
  });

  it("emits dismiss when the dismiss button is clicked", async () => {
    const wrapper = mount(QuestionCard, { props: { approval: makeApproval() } });
    const buttons = wrapper.findAll("button");
    await buttons[1]!.trigger("click");
    expect(wrapper.emitted("dismiss")).toHaveLength(1);
  });
});
