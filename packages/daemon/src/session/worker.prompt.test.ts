import { describe, expect, it } from "vitest";
import { makeProject } from "../test-support.ts";
import { buildEpicContextBlock, buildIssuePrompt, buildPriorAttemptBlock, buildSystemPromptAppend } from "./worker.ts";

const project = makeProject();
const issue = { number: 42, title: "the ticket", body: "the body" };

describe("buildIssuePrompt", () => {
  it("builds the plain issue prompt with no epic context and no comments", () => {
    const prompt = buildIssuePrompt(project, issue, []);
    expect(prompt).toBe("GitHub issue #42 in acme/alpha: the ticket\n\nthe body");
  });

  it("falls back to a placeholder for an empty body", () => {
    expect(buildIssuePrompt(project, { ...issue, body: "" }, [])).toContain("(no description)");
  });

  it("appends a discussion section when there are comments", () => {
    const prompt = buildIssuePrompt(project, issue, ["@alice: please also handle X"]);
    expect(prompt).toContain("## Discussion on the issue");
    expect(prompt).toContain("@alice: please also handle X");
  });

  it("prepends the epic context block ahead of the issue body", () => {
    const prompt = buildIssuePrompt(project, issue, [], "## Part of epic #7\n\nsome context");
    expect(prompt.startsWith("## Part of epic #7")).toBe(true);
    expect(prompt.indexOf("## Part of epic #7")).toBeLessThan(prompt.indexOf("the body"));
  });

  it("omits the epic section entirely when there is no epic context", () => {
    const prompt = buildIssuePrompt(project, issue, []);
    expect(prompt).not.toContain("Part of epic");
  });

  it("omits the prior-attempt section on a first attempt", () => {
    const prompt = buildIssuePrompt(project, issue, []);
    expect(prompt).not.toContain("Prior attempt");
  });

  it("prepends the prior-attempt block ahead of the issue body when given", () => {
    const prompt = buildIssuePrompt(project, issue, [], undefined, "## Prior attempt\n\nsome history");
    expect(prompt.startsWith("## Prior attempt")).toBe(true);
    expect(prompt.indexOf("## Prior attempt")).toBeLessThan(prompt.indexOf("the body"));
  });
});

describe("buildPriorAttemptBlock", () => {
  it("returns undefined for a first attempt (no record)", () => {
    expect(buildPriorAttemptBlock(undefined)).toBeUndefined();
  });

  it("returns undefined when the record carries no summary of any kind", () => {
    expect(buildPriorAttemptBlock({})).toBeUndefined();
  });

  it("surfaces lastSummary when there is no preserved priorAttemptSummary", () => {
    const block = buildPriorAttemptBlock({ lastSummary: "timed out after 30 minutes" });
    expect(block).toContain("## Prior attempt");
    expect(block).toContain("timed out after 30 minutes");
  });

  it("prefers priorAttemptSummary over lastSummary — the pre-restart value over restart boilerplate", () => {
    const block = buildPriorAttemptBlock({
      lastSummary: "Restarted from the dashboard — a fresh session will pick this up.",
      priorAttemptSummary: "Got stuck on a flaky test in the payments module.",
    });
    expect(block).toContain("Got stuck on a flaky test in the payments module.");
    expect(block).not.toContain("Restarted from the dashboard");
  });

  it("caps the surfaced text so a pathological history can't blow up the prompt", () => {
    const block = buildPriorAttemptBlock({ lastSummary: "x".repeat(5000) });
    expect(block!.length).toBeLessThan(1200);
  });
});

describe("buildEpicContextBlock", () => {
  const epic = { number: 7, title: "the epic", body: "epic description here" };

  it("names the epic and quotes an excerpt of its body", () => {
    const block = buildEpicContextBlock(epic);
    expect(block).toContain("This ticket is part of epic #7: the epic.");
    expect(block).toContain("epic description here");
  });

  it("includes sibling position when given", () => {
    const block = buildEpicContextBlock(epic, { index: 2, total: 5 });
    expect(block).toContain("ticket 2 of 5");
  });

  it("omits sibling position when not given", () => {
    const block = buildEpicContextBlock(epic);
    expect(block).not.toMatch(/ticket \d+ of \d+/);
  });

  it("caps the body excerpt so a huge epic body can't dominate the prompt", () => {
    const block = buildEpicContextBlock({ ...epic, body: "x".repeat(2000) });
    expect(block.length).toBeLessThan(700);
  });
});

describe("buildSystemPromptAppend", () => {
  it("a code session with no type contract is byte-for-byte the plain worker contract", () => {
    expect(buildSystemPromptAppend("code")).toContain("You are a fleet worker");
    expect(buildSystemPromptAppend("code")).toBe(buildSystemPromptAppend("code", undefined));
  });

  it("a code session with a type contract appends it after the worker contract", () => {
    const appendix = buildSystemPromptAppend("code", "Run the backend test suite before declaring done.");
    expect(appendix.startsWith("You are a fleet worker")).toBe(true);
    expect(appendix).toContain("Run the backend test suite before declaring done.");
    expect(appendix.indexOf("You are a fleet worker")).toBeLessThan(appendix.indexOf("Run the backend test suite"));
  });

  it("a plan session ignores any type contract entirely — untyped and typed planners are byte-for-byte identical", () => {
    const plain = buildSystemPromptAppend("plan");
    expect(plain).toContain("You are a fleet planning agent");
    expect(buildSystemPromptAppend("plan", "some type contract")).toBe(plain);
  });

  it("a code session with no verify commands is unaffected by an empty list", () => {
    expect(buildSystemPromptAppend("code", undefined, [])).toBe(buildSystemPromptAppend("code"));
  });

  it("a code session with verify commands appends them as required before completion", () => {
    const appendix = buildSystemPromptAppend("code", undefined, ["pnpm typecheck", "pnpm test"]);
    expect(appendix).toContain("Required verification for this ticket type");
    expect(appendix).toContain("- `pnpm typecheck`");
    expect(appendix).toContain("- `pnpm test`");
    expect(appendix).toContain('status "completed"');
  });

  it("a code session with both a type contract and verify commands appends both, contract first", () => {
    const appendix = buildSystemPromptAppend("code", "Run the backend test suite before declaring done.", ["pnpm test"]);
    expect(appendix.indexOf("Run the backend test suite")).toBeLessThan(appendix.indexOf("Required verification"));
    expect(appendix).toContain("- `pnpm test`");
  });

  it("a plan session ignores verify commands entirely — untyped and typed planners are byte-for-byte identical", () => {
    const plain = buildSystemPromptAppend("plan");
    expect(buildSystemPromptAppend("plan", undefined, ["pnpm test"])).toBe(plain);
  });
});
