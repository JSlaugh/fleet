import { describe, expect, it } from "vitest";
import {
  FleetConfigSchema,
  PlanResultSchema,
  ProjectConfigSchema,
  WorkerResultSchema,
  boardStatusFromLabels,
  mergeModelUsage,
  parseWorkerQuestions,
  priorityOf,
  shortModelName,
} from "./index.ts";

const minimalProject = { name: "alpha", repoPath: "/repo/alpha", githubRepo: "acme/alpha" };
const minimalFleetConfig = { worktreeRoot: "/tmp/wt", projects: [minimalProject] };

describe("boardStatusFromLabels", () => {
  it("maps each fleet label to its board status", () => {
    expect(boardStatusFromLabels(["fleet:ready"])).toBe("ready");
    expect(boardStatusFromLabels(["fleet:in-progress"])).toBe("in-progress");
    expect(boardStatusFromLabels(["fleet:needs-input"])).toBe("needs-input");
    expect(boardStatusFromLabels(["fleet:review"])).toBe("review");
  });

  it("returns null when no board label is present", () => {
    expect(boardStatusFromLabels(["fleet:p1", "bug"])).toBeNull();
  });

  it("prefers ready when multiple board labels are present", () => {
    expect(boardStatusFromLabels(["fleet:review", "fleet:ready"])).toBe("ready");
  });
});

describe("priorityOf", () => {
  it("returns the matching priority label", () => {
    expect(priorityOf(["fleet:p2"])).toBe("fleet:p2");
  });

  it("returns the highest priority when several are present", () => {
    expect(priorityOf(["fleet:p3", "fleet:p1"])).toBe("fleet:p1");
  });

  it("returns null with no priority label", () => {
    expect(priorityOf(["fleet:ready"])).toBeNull();
  });
});

describe("shortModelName", () => {
  it("strips the claude- prefix and date suffix", () => {
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });

  it("leaves a name without prefix/suffix mostly intact", () => {
    expect(shortModelName("opus-4-8")).toBe("opus-4-8");
  });

  it("returns an empty string for undefined", () => {
    expect(shortModelName(undefined)).toBe("");
  });
});

describe("mergeModelUsage", () => {
  const opus = { inputTokens: 100, outputTokens: 10, costUsd: 0.5 };
  const haiku = { inputTokens: 20, outputTokens: 5, costUsd: 0.01 };

  it("returns undefined when both sides are undefined", () => {
    expect(mergeModelUsage(undefined, undefined)).toBeUndefined();
  });

  it("returns a copy of whichever side is present", () => {
    expect(mergeModelUsage(undefined, { opus })).toEqual({ opus });
    expect(mergeModelUsage({ opus }, undefined)).toEqual({ opus });
  });

  it("sums overlapping keys field by field", () => {
    expect(mergeModelUsage({ opus }, { opus })).toEqual({
      opus: { inputTokens: 200, outputTokens: 20, costUsd: 1 },
    });
  });

  it("unions disjoint keys", () => {
    expect(mergeModelUsage({ opus }, { haiku })).toEqual({ opus, haiku });
  });

  it("does not mutate either input", () => {
    const base = { opus: { ...opus } };
    const delta = { opus: { ...opus }, haiku: { ...haiku } };
    mergeModelUsage(base, delta);
    expect(base).toEqual({ opus });
    expect(delta).toEqual({ opus, haiku });
  });
});

describe("parseWorkerQuestions", () => {
  it("returns [] for a non-object input", () => {
    expect(parseWorkerQuestions("nope")).toEqual([]);
    expect(parseWorkerQuestions(null)).toEqual([]);
    expect(parseWorkerQuestions(42)).toEqual([]);
  });

  it("returns [] when questions is missing or not an array", () => {
    expect(parseWorkerQuestions({})).toEqual([]);
    expect(parseWorkerQuestions({ questions: "x" })).toEqual([]);
  });

  it("keeps valid entries and filters out invalid ones", () => {
    const parsed = parseWorkerQuestions({
      questions: [
        { question: "Which DB?", header: "DB", options: [{ label: "pg" }] },
        { header: "no question field" }, // invalid — dropped
        "not an object", // invalid — dropped
        { question: "Deploy now?" },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed.map((q) => q.question)).toEqual(["Which DB?", "Deploy now?"]);
  });
});

describe("PlanResultSchema", () => {
  it("parses a completed plan with tickets", () => {
    const parsed = PlanResultSchema.safeParse({
      status: "completed",
      summary: "Split the epic into three tickets.",
      tickets: [
        { title: "Add X", body: "Problem, acceptance criteria, verification." },
        { title: "Add Y", body: "Problem, acceptance criteria, verification.", priority: "fleet:p2" },
      ],
      confidence: "high",
    });
    expect(parsed.success).toBe(true);
  });

  it("parses a blocked plan with no tickets", () => {
    const parsed = PlanResultSchema.safeParse({
      status: "blocked",
      summary: "Epic is too vague to decompose.",
      tickets: [],
      blockedReason: "Which subsystem should this target?",
      confidence: "low",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown priority label", () => {
    const parsed = PlanResultSchema.safeParse({
      status: "completed",
      summary: "s",
      tickets: [{ title: "t", body: "b", priority: "fleet:urgent" }],
      confidence: "high",
    });
    expect(parsed.success).toBe(false);
  });

  it("parses tickets with a tier and defaults tier to undefined", () => {
    const parsed = PlanResultSchema.safeParse({
      status: "completed",
      summary: "s",
      tickets: [
        { title: "light one", body: "b", tier: "light" },
        { title: "elevated one", body: "b", tier: "elevated" },
        { title: "no tier", body: "b" },
      ],
      confidence: "high",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tickets.map((t) => t.tier)).toEqual(["light", "elevated", undefined]);
    }
  });

  it("rejects an unknown tier", () => {
    const parsed = PlanResultSchema.safeParse({
      status: "completed",
      summary: "s",
      tickets: [{ title: "t", body: "b", tier: "urgent" }],
      confidence: "high",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires status, summary, tickets, and confidence", () => {
    expect(PlanResultSchema.safeParse({}).success).toBe(false);
    expect(
      PlanResultSchema.safeParse({ status: "completed", summary: "s", confidence: "high" }).success,
    ).toBe(false);
  });
});

describe("ProjectConfigSchema", () => {
  it("parses the minimal required fields and applies defaults for the rest", () => {
    const parsed = ProjectConfigSchema.parse(minimalProject);
    expect(parsed.defaultBranch).toBe("main");
    expect(parsed.maxConcurrent).toBe(1);
    expect(parsed.planChildrenReady).toBe(false);
    expect(parsed.autoElevateOnFailure).toBe(true);
    expect(parsed.autoAddressReviews).toBe(true);
    expect(parsed.machineReview).toBe(true);
    expect(parsed.setupCommand).toBeUndefined();
  });

  it("rejects an empty name or repoPath", () => {
    expect(ProjectConfigSchema.safeParse({ ...minimalProject, name: "" }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ ...minimalProject, repoPath: "" }).success).toBe(false);
  });

  it("requires githubRepo to look like owner/repo", () => {
    expect(ProjectConfigSchema.safeParse({ ...minimalProject, githubRepo: "not-a-repo" }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ ...minimalProject, githubRepo: "a/b/c" }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ ...minimalProject, githubRepo: "acme/fleet" }).success).toBe(true);
  });

  it("rejects maxConcurrent below 1 or non-integer", () => {
    expect(ProjectConfigSchema.safeParse({ ...minimalProject, maxConcurrent: 0 }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ ...minimalProject, maxConcurrent: 1.5 }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ ...minimalProject, maxConcurrent: 2 }).success).toBe(true);
  });
});

describe("FleetConfigSchema", () => {
  it("parses the minimal required fields and applies defaults for the rest", () => {
    const parsed = FleetConfigSchema.parse(minimalFleetConfig);
    expect(parsed.pollIntervalSeconds).toBe(60);
    expect(parsed.dashboardPort).toBe(4400);
    expect(parsed.stalledAfterMinutes).toBe(10);
    expect(parsed.ticketTimeoutMinutes).toBe(30);
    expect(parsed.approvalTimeoutMinutes).toBe(10);
    expect(parsed.replyWaitMinutes).toBe(60);
    expect(parsed.limitResumeSlackMinutes).toBe(5);
    expect(parsed.limitDefaultBackoffMinutes).toBe(300);
    expect(parsed.dataDir).toBe(".fleet");
  });

  it("requires worktreeRoot to be non-empty", () => {
    expect(FleetConfigSchema.safeParse({ ...minimalFleetConfig, worktreeRoot: "" }).success).toBe(false);
  });

  it("requires at least one project", () => {
    expect(FleetConfigSchema.safeParse({ ...minimalFleetConfig, projects: [] }).success).toBe(false);
  });

  it("enforces each field's min constraint", () => {
    const cases: [string, number][] = [
      ["pollIntervalSeconds", 9],
      ["dashboardPort", 0],
      ["stalledAfterMinutes", 0],
      ["ticketTimeoutMinutes", 0],
      ["approvalTimeoutMinutes", 0],
      ["replyWaitMinutes", 0],
      ["limitResumeSlackMinutes", -1],
      ["limitDefaultBackoffMinutes", 0],
    ];
    for (const [field, belowMin] of cases) {
      const result = FleetConfigSchema.safeParse({ ...minimalFleetConfig, [field]: belowMin });
      expect(result.success, `${field} should reject ${belowMin}`).toBe(false);
    }
  });

  it("allows limitResumeSlackMinutes of 0 (its min is 0, unlike the other duration fields)", () => {
    expect(FleetConfigSchema.safeParse({ ...minimalFleetConfig, limitResumeSlackMinutes: 0 }).success).toBe(true);
  });

  it("rejects non-integer values for integer fields", () => {
    expect(FleetConfigSchema.safeParse({ ...minimalFleetConfig, pollIntervalSeconds: 10.5 }).success).toBe(false);
  });
});

describe("WorkerResultSchema", () => {
  const base = {
    summary: "Did the thing.",
    filesChanged: ["src/index.ts"],
    confidence: "high" as const,
  };

  it("parses a completed result with prTitle/prBody", () => {
    const parsed = WorkerResultSchema.safeParse({
      ...base,
      status: "completed",
      prTitle: "feat: add thing",
      prBody: "Adds the thing.",
    });
    expect(parsed.success).toBe(true);
  });

  it("parses a blocked result with blockedReason", () => {
    const parsed = WorkerResultSchema.safeParse({
      ...base,
      status: "blocked",
      blockedReason: "Which database should this target?",
    });
    expect(parsed.success).toBe(true);
  });

  it("does not itself enforce prTitle/prBody/blockedReason presence — they're optional at the schema level", () => {
    // The status/field pairing is a documented contract enforced by the worker prompt,
    // not the zod schema: a bare completed/blocked with none of the optional fields still parses.
    expect(WorkerResultSchema.safeParse({ ...base, status: "completed" }).success).toBe(true);
    expect(WorkerResultSchema.safeParse({ ...base, status: "blocked" }).success).toBe(true);
  });

  it("rejects an unknown status or confidence", () => {
    expect(WorkerResultSchema.safeParse({ ...base, status: "done" }).success).toBe(false);
    expect(WorkerResultSchema.safeParse({ ...base, status: "completed", confidence: "certain" }).success).toBe(false);
  });

  it("requires summary, filesChanged, and confidence", () => {
    expect(WorkerResultSchema.safeParse({ status: "completed" }).success).toBe(false);
    expect(WorkerResultSchema.safeParse({ ...base, filesChanged: undefined }).success).toBe(false);
  });

  it("requires filesChanged to be an array of strings", () => {
    expect(WorkerResultSchema.safeParse({ ...base, status: "completed", filesChanged: "src/index.ts" }).success).toBe(
      false,
    );
  });
});
