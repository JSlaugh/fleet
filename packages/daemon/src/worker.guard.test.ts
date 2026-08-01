import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_BASH_REASON,
  FORBIDDEN_COMMIT_REASON,
  PLAN_OUTPUT_SCHEMA,
  WORKER_OUTPUT_SCHEMA,
  denyForbiddenBash,
  denyForbiddenPlanBash,
  isForbiddenBashCommand,
  isForbiddenPlanBashCommand,
} from "./worker.ts";

const hookOptions = { signal: new AbortController().signal };

function preToolUse(toolName: string, toolInput: unknown) {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tu_1",
    session_id: "s1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
  };
}

describe("isForbiddenBashCommand", () => {
  it.each([
    "git push",
    "git push --force origin fleet/3",
    "git -C ../x push --force",
    "GIT PUSH",
    "gh pr create -t x",
    "gh pr merge 12 --squash",
    "gh pr close 12",
    "gh pr edit 12 --add-label foo",
    "gh issue edit 5 --add-label foo",
    "gh issue close 5",
    "gh issue comment 5 --body hi",
    "gh label create fleet:ready",
    "gh label delete fleet:ready",
    // Chained after an innocuous command.
    "pnpm test && git push",
    // rtk-rewritten commands (see .claude/settings.json PreToolUse hook): the
    // word-boundary patterns must still match past the `rtk` prefix.
    "rtk git push",
    "rtk gh pr create -t x",
    "rtk gh issue close 5",
  ])("blocks %j", (command) => {
    expect(isForbiddenBashCommand(command)).toBe(true);
  });

  it.each([
    "git commit -m x",
    "git log",
    "git status",
    "git add -A",
    "git diff --stat",
    "pnpm test",
    "pnpm typecheck",
    "gh pr view 12",
    "gh pr diff 12",
    "gh issue view 3",
    "gh issue list --label fleet:ready",
    // `push` as a bare word belongs to no git/gh command.
    "npm run push-check",
    // rtk-rewritten read-only commands stay allowed.
    "rtk git status",
    "rtk gh pr view 12",
  ])("allows %j", (command) => {
    expect(isForbiddenBashCommand(command)).toBe(false);
  });

  it("does not read across a command separator", () => {
    // `push` here is a separate command, not an argument to `git`.
    expect(isForbiddenBashCommand("git status; ./push")).toBe(false);
    expect(isForbiddenBashCommand("git status && pnpm run deploy")).toBe(false);
  });

  it("errs toward blocking on quoted text (documented false positive)", () => {
    expect(isForbiddenBashCommand('echo "git push"')).toBe(true);
  });
});

describe("denyForbiddenBash", () => {
  it("denies a forbidden Bash command with an explanatory reason", async () => {
    const out = await denyForbiddenBash(preToolUse("Bash", { command: "git push" }), "tu_1", hookOptions);
    expect(out).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: FORBIDDEN_BASH_REASON,
      },
    });
  });

  it("leaves ordinary Bash commands alone", async () => {
    const out = await denyForbiddenBash(preToolUse("Bash", { command: "pnpm test" }), "tu_1", hookOptions);
    expect(out).toEqual({ continue: true });
  });

  it("ignores non-Bash tools and malformed input", async () => {
    expect(await denyForbiddenBash(preToolUse("Read", { command: "git push" }), "tu_1", hookOptions)).toEqual({
      continue: true,
    });
    expect(await denyForbiddenBash(preToolUse("Bash", null), "tu_1", hookOptions)).toEqual({ continue: true });
    expect(await denyForbiddenBash(preToolUse("Bash", { command: 42 }), "tu_1", hookOptions)).toEqual({
      continue: true,
    });
  });
});

describe("isForbiddenPlanBashCommand", () => {
  it("also blocks git commit, on top of every code-session restriction", () => {
    expect(isForbiddenPlanBashCommand("git commit -m x")).toBe(true);
    expect(isForbiddenPlanBashCommand("git commit --amend")).toBe(true);
    expect(isForbiddenPlanBashCommand("git push")).toBe(true);
    expect(isForbiddenPlanBashCommand("gh pr create -t x")).toBe(true);
  });

  it("still allows read-only git/gh commands", () => {
    expect(isForbiddenPlanBashCommand("git status")).toBe(false);
    expect(isForbiddenPlanBashCommand("git log")).toBe(false);
    expect(isForbiddenPlanBashCommand("gh issue view 3")).toBe(false);
  });

  it("does not read commit across a command separator", () => {
    expect(isForbiddenPlanBashCommand("git status; ./commit")).toBe(false);
  });
});

describe("denyForbiddenPlanBash", () => {
  it("denies git commit with a planning-specific reason", async () => {
    const out = await denyForbiddenPlanBash(preToolUse("Bash", { command: "git commit -m x" }), "tu_1", hookOptions);
    expect(out).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: FORBIDDEN_COMMIT_REASON,
      },
    });
  });

  it("denies git push with the shared reason", async () => {
    const out = await denyForbiddenPlanBash(preToolUse("Bash", { command: "git push" }), "tu_1", hookOptions);
    expect(out).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: FORBIDDEN_BASH_REASON,
      },
    });
  });

  it("leaves ordinary read-only Bash commands alone", async () => {
    const out = await denyForbiddenPlanBash(preToolUse("Bash", { command: "git log" }), "tu_1", hookOptions);
    expect(out).toEqual({ continue: true });
  });
});

describe("PLAN_OUTPUT_SCHEMA", () => {
  it("keeps the converted zod schema's properties", () => {
    const properties = PLAN_OUTPUT_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["status", "summary", "tickets", "blockedReason", "confidence"]),
    );
  });

  it("carries no top-level combinator, which the API rejects in a tool input_schema", () => {
    expect(PLAN_OUTPUT_SCHEMA.allOf).toBeUndefined();
    expect(PLAN_OUTPUT_SCHEMA.anyOf).toBeUndefined();
    expect(PLAN_OUTPUT_SCHEMA.oneOf).toBeUndefined();
  });
});

describe("WORKER_OUTPUT_SCHEMA", () => {
  it("keeps the converted zod schema's properties", () => {
    const properties = WORKER_OUTPUT_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["status", "summary", "filesChanged", "prTitle", "prBody", "blockedReason", "confidence"]),
    );
  });

  it("carries no top-level combinator, which the API rejects in a tool input_schema", () => {
    expect(WORKER_OUTPUT_SCHEMA.allOf).toBeUndefined();
    expect(WORKER_OUTPUT_SCHEMA.anyOf).toBeUndefined();
    expect(WORKER_OUTPUT_SCHEMA.oneOf).toBeUndefined();
  });

  it("requires only the fields every result carries, whatever the status", () => {
    expect(WORKER_OUTPUT_SCHEMA.required).toEqual(
      expect.arrayContaining(["status", "summary", "filesChanged", "confidence"]),
    );
    expect(WORKER_OUTPUT_SCHEMA.required).not.toContain("prTitle");
    expect(WORKER_OUTPUT_SCHEMA.required).not.toContain("blockedReason");
  });
});
