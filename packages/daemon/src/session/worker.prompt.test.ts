import { describe, expect, it } from "vitest";
import { makeProject } from "../test-support.ts";
import { buildEpicContextBlock, buildIssuePrompt } from "./worker.ts";

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
