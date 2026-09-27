import type { PendingApproval } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { answerModal, approvalMessage, composeAnswers, customId, inputPreview, parseCustomId, settledMessage } from "./render.ts";

function approval(patch: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "apr-1-7",
    project: "alpha",
    issueNumber: 7,
    toolName: "Bash",
    kind: "permission",
    input: { command: "rm -rf dist" },
    createdAt: "2026-01-01T10:00:00.000Z",
    ...patch,
  };
}

const questions = (n: number) => ({
  questions: Array.from({ length: n }, (_, i) => ({ question: `Question ${i + 1}?`, header: `Q${i + 1}`, options: [{ label: "yes" }, { label: "no" }] })),
});

describe("custom ids", () => {
  it("round-trips fleet:<approvalId>:<action> and rejects anything else", () => {
    expect(parseCustomId(customId("apr-3-12", "deny"))).toEqual({ approvalId: "apr-3-12", action: "deny" });
    expect(parseCustomId("fleet:apr-3-12:explode")).toBeUndefined();
    expect(parseCustomId("other:apr-3-12:approve")).toBeUndefined();
  });
});

describe("inputPreview", () => {
  it("shows a Bash command, a question's first text, or a JSON excerpt — capped at 200 chars", () => {
    expect(inputPreview(approval())).toBe("rm -rf dist");
    expect(inputPreview(approval({ toolName: "AskUserQuestion", kind: "question", input: questions(2) }))).toBe("Question 1?");
    expect(inputPreview(approval({ toolName: "WebFetch", input: { url: "https://x" } }))).toBe('{"url":"https://x"}');
    const long = inputPreview(approval({ input: { command: "x".repeat(500) } }));
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("approvalMessage", () => {
  it("gives a tool approval Approve/Deny buttons and its expiry", () => {
    const message = approvalMessage(approval(), { approvalTimeoutMs: 10 * 60_000, ticketTitle: "Add a thing" });
    expect(message.title).toBe("alpha#7 — Bash");
    expect(message.description).toBe("Add a thing");
    expect(message.buttons.map((b) => [b.customId, b.label])).toEqual([
      ["fleet:apr-1-7:approve", "Approve"],
      ["fleet:apr-1-7:deny", "Deny"],
    ]);
    const expires = Math.floor(Date.parse("2026-01-01T10:10:00.000Z") / 1000);
    expect(message.fields.find((f) => f.name === "Expires")?.value).toContain(`<t:${expires}:R>`);
  });

  it("gives a question a single Answer button", () => {
    const message = approvalMessage(approval({ toolName: "AskUserQuestion", kind: "question", input: questions(1) }), { approvalTimeoutMs: 60_000 });
    expect(message.buttons.map((b) => b.label)).toEqual(["Answer"]);
  });
});

describe("settledMessage", () => {
  const live = approvalMessage(approval(), { approvalTimeoutMs: 60_000 });

  it("removes the buttons and records who acted", () => {
    const settled = settledMessage(live, "allowed", { name: "joe" }, Date.parse("2026-01-01T10:01:00.000Z"));
    expect(settled.buttons).toEqual([]);
    expect(settled.fields.find((f) => f.name === "Outcome")?.value).toMatch(/^Approved by joe at <t:\d+:t>$/);
    expect(settled.fields.some((f) => f.name === "Expires")).toBe(false);
  });

  it("attributes non-Discord settles to the dashboard, and says a timeout finishes the ticket blocked", () => {
    expect(settledMessage(live, "denied", undefined, 0).fields.at(-1)?.value).toMatch(/^Denied via the dashboard/);
    expect(settledMessage(live, "timed out", undefined, 0).fields.at(-1)?.value).toMatch(/^Timed out; ticket will finish blocked at/);
  });
});

describe("answerModal / composeAnswers", () => {
  it("has one input per question (up to five) and formats answers like the dashboard", () => {
    const q = approval({ toolName: "AskUserQuestion", kind: "question", input: questions(2) });
    const modal = answerModal(q);
    expect(modal.customId).toBe("fleet:apr-1-7:answer");
    expect(modal.inputs.map((i) => i.label)).toEqual(["Q1", "Q2"]);
    expect(modal.inputs[0]?.placeholder).toBe("Options: yes | no");
    expect(composeAnswers(q, ["yes", ""])).toBe("Q: Question 1?\nA: yes\n\nQ: Question 2?\nA: (no answer)");
  });

  it("falls back to one free-text field past Discord's five-component limit", () => {
    const q = approval({ toolName: "AskUserQuestion", kind: "question", input: questions(6) });
    expect(answerModal(q).inputs).toHaveLength(1);
    expect(composeAnswers(q, ["all yes"])).toBe(`${Array.from({ length: 6 }, (_, i) => `Q: Question ${i + 1}?`).join("\n")}\nA: all yes`);
  });

  it("treats all-blank answers as no answer", () => {
    expect(composeAnswers(approval({ toolName: "AskUserQuestion", kind: "question", input: questions(2) }), [" ", ""])).toBeUndefined();
  });
});
