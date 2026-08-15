import type { ProjectConfig } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./exec.ts", async (importActual) => ({
  ...(await importActual<typeof import("./exec.ts")>()),
  run: vi.fn(),
  runJson: vi.fn(),
}));

const exec = await import("./exec.ts");
const {
  buildConflictPrompt,
  buildPrFeedback,
  buildReviewFeedbackPrompt,
  dependencyStatus,
  escalateLabelArgs,
  getPrChecks,
  issueNumberFromUrl,
  mergePullRequest,
  parseDependsOn,
  priorityRank,
  readyLabelArgs,
} = await import("./github.ts");

const project = {
  name: "alpha",
  repoPath: "/repo/alpha",
  githubRepo: "acme/alpha",
  defaultBranch: "main",
  maxConcurrent: 1,
  maxInReview: 3,
  planChildrenReady: false,
  autoElevateOnFailure: true,
  autoAddressReviews: true,
  machineReview: false,
  autoMerge: false,
  mergeMethod: "squash",
} satisfies ProjectConfig;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("priorityRank", () => {
  it("ranks p1 above p2 above p3", () => {
    expect(priorityRank(["fleet:p1"])).toBeLessThan(priorityRank(["fleet:p2"]));
    expect(priorityRank(["fleet:p2"])).toBeLessThan(priorityRank(["fleet:p3"]));
  });

  it("returns the lowest rank (largest number) when no priority label is present", () => {
    expect(priorityRank(["fleet:ready"])).toBe(3);
    expect(priorityRank([])).toBe(3);
  });

  it("uses the highest priority when several are present", () => {
    expect(priorityRank(["fleet:p3", "fleet:p1"])).toBe(0);
  });
});

describe("readyLabelArgs", () => {
  const project = {
    name: "alpha",
    repoPath: "/repo/alpha",
    githubRepo: "acme/alpha",
    defaultBranch: "main",
    maxConcurrent: 1,
    maxInReview: 3,
    planChildrenReady: false,
    autoElevateOnFailure: true,
    autoAddressReviews: true,
    machineReview: false,
    autoMerge: false,
    mergeMethod: "squash",
  } satisfies ProjectConfig;

  it("removes every other fleet state label and adds fleet:ready", () => {
    expect(readyLabelArgs(project, 7)).toEqual([
      "issue", "edit", "7",
      "--repo", "acme/alpha",
      "--remove-label", "fleet:in-progress",
      "--remove-label", "fleet:needs-input",
      "--remove-label", "fleet:review",
      "--add-label", "fleet:ready",
    ]);
  });

  it("never removes fleet:ready itself", () => {
    expect(readyLabelArgs(project, 7).filter((a) => a === "fleet:ready")).toEqual(["fleet:ready"]);
  });
});

describe("escalateLabelArgs", () => {
  const project = {
    name: "alpha",
    repoPath: "/repo/alpha",
    githubRepo: "acme/alpha",
    defaultBranch: "main",
    maxConcurrent: 1,
    maxInReview: 3,
    planChildrenReady: false,
    autoElevateOnFailure: true,
    autoAddressReviews: true,
    machineReview: false,
    autoMerge: false,
    mergeMethod: "squash",
  } satisfies ProjectConfig;

  it("swaps in-progress for elevate + ready", () => {
    expect(escalateLabelArgs(project, 7)).toEqual([
      "issue", "edit", "7",
      "--repo", "acme/alpha",
      "--remove-label", "fleet:in-progress",
      "--add-label", "fleet:elevate",
      "--add-label", "fleet:ready",
    ]);
  });
});

describe("issueNumberFromUrl", () => {
  it("takes the number from the last path segment", () => {
    expect(issueNumberFromUrl("https://github.com/JSlaugh/fleet/issues/42")).toBe(42);
  });

  it("tolerates surrounding whitespace", () => {
    expect(issueNumberFromUrl("  https://github.com/JSlaugh/fleet/issues/7\n")).toBe(7);
  });

  it("throws when gh printed something unexpected", () => {
    expect(() => issueNumberFromUrl("")).toThrow();
    expect(() => issueNumberFromUrl("Creating issue in JSlaugh/fleet")).toThrow();
  });
});

describe("parseDependsOn", () => {
  it("returns [] when there is no Depends-on line", () => {
    expect(parseDependsOn("Just a plain description.")).toEqual([]);
  });

  it("parses a single dependency", () => {
    expect(parseDependsOn("Depends-on: #12")).toEqual([12]);
  });

  it("parses multiple comma-separated dependencies", () => {
    expect(parseDependsOn("Depends-on: #12, #14")).toEqual([12, 14]);
  });

  it("accepts mixed comma and space separators", () => {
    expect(parseDependsOn("Depends-on: #12 #14, #16")).toEqual([12, 14, 16]);
  });

  it("ignores malformed entries but keeps the valid ones", () => {
    expect(parseDependsOn("Depends-on: #12, banana, 14, #16")).toEqual([12, 16]);
  });

  it("is case-insensitive on the key", () => {
    expect(parseDependsOn("depends-on: #5")).toEqual([5]);
    expect(parseDependsOn("DEPENDS-ON: #5")).toEqual([5]);
  });

  it("finds the line anywhere in a multi-line body", () => {
    const body = ["## Problem", "Some description.", "", "Depends-on: #3", "", "## More"].join("\n");
    expect(parseDependsOn(body)).toEqual([3]);
  });

  it("dedupes repeated references", () => {
    expect(parseDependsOn("Depends-on: #4, #4")).toEqual([4]);
  });
});

describe("dependencyStatus", () => {
  it("reports no dependency as blocking or unknown when there are none", () => {
    expect(dependencyStatus([], new Set(), new Set())).toEqual({ blockedBy: [], unknown: [] });
  });

  it("treats an open dependency as blocking", () => {
    expect(dependencyStatus([12], new Set([12]), new Set([12]))).toEqual({ blockedBy: [12], unknown: [] });
  });

  it("treats a closed dependency as satisfied", () => {
    expect(dependencyStatus([12], new Set(), new Set([12]))).toEqual({ blockedBy: [], unknown: [] });
  });

  it("treats a nonexistent dependency as satisfied but flags it as unknown", () => {
    expect(dependencyStatus([999], new Set(), new Set())).toEqual({ blockedBy: [], unknown: [999] });
  });

  it("handles a mix of blocking, satisfied, and unknown deps", () => {
    expect(dependencyStatus([1, 2, 999], new Set([1]), new Set([1, 2]))).toEqual({
      blockedBy: [1],
      unknown: [999],
    });
  });
});

function review(patch: Partial<{ user: { login: string } | null; state: string; body: string | null; submitted_at: string }> = {}) {
  return {
    user: { login: "reviewer" },
    state: "COMMENTED",
    body: "looks good",
    submitted_at: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function reviewComment(patch: Partial<{ path: string; line: number | null; body: string | null; user: { login: string } | null; created_at: string }> = {}) {
  return {
    path: "src/index.ts",
    line: 10,
    body: "please fix this",
    user: { login: "reviewer" },
    created_at: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("buildPrFeedback", () => {
  it("returns nothing when there is nothing new", () => {
    expect(buildPrFeedback([], [], undefined)).toEqual({
      reviews: [],
      comments: [],
      hasChangesRequested: false,
      latestAt: undefined,
    });
  });

  it("ignores an approved review with no body", () => {
    const feedback = buildPrFeedback([review({ state: "APPROVED", body: "" })], [], undefined);
    expect(feedback.reviews).toEqual([]);
    expect(feedback.hasChangesRequested).toBe(false);
  });

  it("flags hasChangesRequested even when the review has no body", () => {
    const feedback = buildPrFeedback([review({ state: "CHANGES_REQUESTED", body: null })], [], undefined);
    expect(feedback.hasChangesRequested).toBe(true);
    expect(feedback.reviews).toEqual([]);
    expect(feedback.latestAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("includes reviews and comments with a meaningful body", () => {
    const feedback = buildPrFeedback(
      [review({ state: "CHANGES_REQUESTED", body: "fix the thing" })],
      [reviewComment()],
      undefined,
    );
    expect(feedback.reviews).toEqual([
      { author: "reviewer", state: "CHANGES_REQUESTED", body: "fix the thing", submittedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(feedback.comments).toEqual([
      { path: "src/index.ts", line: 10, body: "please fix this", author: "reviewer", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("drops the fleet status marker", () => {
    const feedback = buildPrFeedback(
      [],
      [reviewComment({ body: "<!-- fleet-status -->\nsomething" })],
      undefined,
    );
    expect(feedback.comments).toEqual([]);
  });

  it("filters out items at or before the since watermark", () => {
    const older = review({ submitted_at: "2026-01-01T00:00:00.000Z" });
    const newer = review({ submitted_at: "2026-01-02T00:00:00.000Z" });
    const feedback = buildPrFeedback([older, newer], [], "2026-01-01T00:00:00.000Z");
    expect(feedback.reviews).toEqual([
      { author: "reviewer", state: "COMMENTED", body: "looks good", submittedAt: "2026-01-02T00:00:00.000Z" },
    ]);
  });

  it("returns everything when since is undefined", () => {
    const feedback = buildPrFeedback([review()], [reviewComment()], undefined);
    expect(feedback.reviews.length).toBe(1);
    expect(feedback.comments.length).toBe(1);
  });

  it("computes latestAt as the max timestamp across every new item, not just the filtered ones", () => {
    const feedback = buildPrFeedback(
      [review({ state: "CHANGES_REQUESTED", body: null, submitted_at: "2026-01-05T00:00:00.000Z" })],
      [reviewComment({ created_at: "2026-01-02T00:00:00.000Z" })],
      undefined,
    );
    expect(feedback.latestAt).toBe("2026-01-05T00:00:00.000Z");
  });

  it("falls back to 'unknown' when the author user is null", () => {
    const feedback = buildPrFeedback([], [reviewComment({ user: null })], undefined);
    expect(feedback.comments[0]?.author).toBe("unknown");
  });
});

describe("buildReviewFeedbackPrompt", () => {
  it("puts review bodies first, then inline comments grouped by path:line", () => {
    const prompt = buildReviewFeedbackPrompt({
      reviews: [{ author: "alice", state: "CHANGES_REQUESTED", body: "please add tests", submittedAt: "2026-01-01T00:00:00.000Z" }],
      comments: [
        { path: "src/a.ts", line: 5, body: "typo here", author: "bob", createdAt: "2026-01-01T00:00:00.000Z" },
        { path: "src/a.ts", line: 5, body: "also this", author: "carol", createdAt: "2026-01-01T00:00:01.000Z" },
        { path: "src/b.ts", line: 12, body: "rename this", author: "bob", createdAt: "2026-01-01T00:00:02.000Z" },
      ],
    });

    const reviewIndex = prompt.indexOf("please add tests");
    const commentIndex = prompt.indexOf("src/a.ts:5");
    expect(reviewIndex).toBeGreaterThan(-1);
    expect(commentIndex).toBeGreaterThan(reviewIndex);
    expect(prompt.indexOf("typo here")).toBeGreaterThan(commentIndex);
    expect(prompt.indexOf("also this")).toBeGreaterThan(prompt.indexOf("typo here"));
    expect(prompt).toContain("src/b.ts:12");
    expect(prompt).toContain("Address each point, commit your changes, and finish with an updated structured result.");
  });

  it("omits sections that have nothing to say", () => {
    const prompt = buildReviewFeedbackPrompt({ reviews: [], comments: [] });
    expect(prompt).not.toContain("## Review comments");
    expect(prompt).not.toContain("## Inline comments");
  });

  it("uses '?' as the line key for a comment with no line", () => {
    const prompt = buildReviewFeedbackPrompt({
      reviews: [],
      comments: [{ path: "README.md", line: null, body: "fix typo", author: "bob", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(prompt).toContain("README.md:?");
  });
});

describe("buildConflictPrompt", () => {
  it("names the default branch to merge in", () => {
    const prompt = buildConflictPrompt("main");
    expect(prompt).toContain("origin/main");
    expect(prompt).toContain("conflicts with `main`");
  });

  it("asks for a re-run of checks and an updated structured result", () => {
    const prompt = buildConflictPrompt("main");
    expect(prompt).toContain("re-run the project's checks");
    expect(prompt).toContain("finish with an updated structured result");
  });
});

describe("getPrChecks", () => {
  it("parses the reported checks", async () => {
    vi.mocked(exec.run).mockResolvedValue({ stdout: '[{"name":"ci","bucket":"pass"}]', stderr: "" });
    expect(await getPrChecks(project, "https://github.com/acme/alpha/pull/7")).toEqual([{ name: "ci", bucket: "pass" }]);
    expect(exec.run).toHaveBeenCalledWith(
      "gh",
      ["pr", "checks", "https://github.com/acme/alpha/pull/7", "--repo", "acme/alpha", "--json", "name,bucket"],
      { allowFailure: true },
    );
  });

  it("parses the checks JSON even when gh's exit reflects a pending/failing check (empty stderr)", async () => {
    vi.mocked(exec.run).mockResolvedValue({ stdout: '[{"name":"ci","bucket":"pending"}]', stderr: "" });
    expect(await getPrChecks(project, "https://github.com/acme/alpha/pull/7")).toEqual([{ name: "ci", bucket: "pending" }]);
  });

  it("treats gh's own 'no checks reported' message as a real empty list", async () => {
    vi.mocked(exec.run).mockResolvedValue({ stdout: "", stderr: "no checks reported on the 'fleet/7' branch" });
    expect(await getPrChecks(project, "https://github.com/acme/alpha/pull/7")).toEqual([]);
  });

  it("throws instead of defaulting to green when stdout is empty for an unexplained reason", async () => {
    vi.mocked(exec.run).mockResolvedValue({ stdout: "", stderr: "" });
    await expect(getPrChecks(project, "https://github.com/acme/alpha/pull/7")).rejects.toThrow();
  });

  it("throws on a genuine fetch failure (rate limit, auth, network) rather than reading it as green", async () => {
    vi.mocked(exec.run).mockResolvedValue({ stdout: "", stderr: "gh: API rate limit exceeded" });
    await expect(getPrChecks(project, "https://github.com/acme/alpha/pull/7")).rejects.toThrow();
  });

  it("throws when stdout is present but not valid JSON", async () => {
    vi.mocked(exec.run).mockResolvedValue({ stdout: "not json", stderr: "" });
    await expect(getPrChecks(project, "https://github.com/acme/alpha/pull/7")).rejects.toThrow();
  });
});

describe("mergePullRequest", () => {
  it("merges with the requested method's flag", async () => {
    vi.mocked(exec.run).mockResolvedValue({ stdout: "", stderr: "" });
    await mergePullRequest(project, "https://github.com/acme/alpha/pull/7", "rebase");
    expect(exec.run).toHaveBeenCalledWith("gh", [
      "pr", "merge", "https://github.com/acme/alpha/pull/7",
      "--repo", "acme/alpha",
      "--rebase",
    ]);
  });

  it("treats an already-merged PR as success instead of throwing", async () => {
    vi.mocked(exec.run).mockRejectedValueOnce(new Error("gh: Pull request is not mergeable"));
    vi.mocked(exec.runJson).mockResolvedValue({ state: "MERGED" });
    await expect(mergePullRequest(project, "https://github.com/acme/alpha/pull/7", "squash")).resolves.toBeUndefined();
  });

  it("rethrows when the merge failed and the PR is still open", async () => {
    vi.mocked(exec.run).mockRejectedValueOnce(new Error("branch protection"));
    vi.mocked(exec.runJson).mockResolvedValue({ state: "OPEN" });
    await expect(mergePullRequest(project, "https://github.com/acme/alpha/pull/7", "squash")).rejects.toThrow("branch protection");
  });

  it("rethrows the original error even when the PR-state fallback check itself fails", async () => {
    vi.mocked(exec.run).mockRejectedValueOnce(new Error("branch protection"));
    vi.mocked(exec.runJson).mockRejectedValue(new Error("gh: rate limited"));
    await expect(mergePullRequest(project, "https://github.com/acme/alpha/pull/7", "squash")).rejects.toThrow("branch protection");
  });
});
