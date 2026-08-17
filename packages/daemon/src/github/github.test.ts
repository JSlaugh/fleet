import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "../test-support.ts";

vi.mock("./exec.ts", async (importActual) => ({
  ...(await importActual<typeof import("./exec.ts")>()),
  run: vi.fn(),
  runJson: vi.fn(),
}));

const exec = await import("./exec.ts");
const {
  bodyWithChildTaskList,
  bodyWithDependsOn,
  bodyWithPartOf,
  buildConflictPrompt,
  buildPrFeedback,
  buildReviewFeedbackPrompt,
  dependencyStatus,
  escalateLabelArgs,
  getPrChecks,
  getStatusCommentInfo,
  issueNumberFromUrl,
  mergePullRequest,
  parseChildTaskList,
  parseDependsOn,
  parseHeartbeat,
  parsePartOf,
  priorityRank,
  readyLabelArgs,
  refreshHeartbeat,
  refreshHeartbeatIfStale,
  toBoardTicket,
  upsertStatusComment,
} = await import("./github.ts");

const project = makeProject();

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
  const project = makeProject();

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
  const project = makeProject();

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

  it("parses the issue-form-rendered section", () => {
    const body = ["### Depends on", "", "#12 #14", "", "### Priority", "", "P2 - default"].join("\n");
    expect(parseDependsOn(body)).toEqual([12, 14]);
  });

  it("is case-insensitive on the section heading", () => {
    const body = ["### depends on", "", "#5"].join("\n");
    expect(parseDependsOn(body)).toEqual([5]);
  });

  it("returns [] for an unfilled optional section", () => {
    const body = ["### Depends on", "", "_No response_", "", "### Priority", "", "P2 - default"].join("\n");
    expect(parseDependsOn(body)).toEqual([]);
  });

  it("unions dependencies from the line and section forms when both are present", () => {
    const body = ["Depends-on: #1", "", "### Depends on", "", "#2"].join("\n");
    expect(parseDependsOn(body)).toEqual([1, 2]);
  });
});

describe("bodyWithDependsOn", () => {
  it("leaves the body untouched when there are no dependencies", () => {
    expect(bodyWithDependsOn("details", undefined)).toBe("details");
    expect(bodyWithDependsOn("details", [])).toBe("details");
  });

  it("appends a Depends-on line for a single dependency", () => {
    expect(bodyWithDependsOn("details", [12])).toBe("details\n\nDepends-on: #12");
  });

  it("appends a Depends-on line listing every dependency", () => {
    expect(bodyWithDependsOn("details", [12, 14])).toBe("details\n\nDepends-on: #12, #14");
  });

  it("doesn't leave a leading blank line when the body is empty", () => {
    expect(bodyWithDependsOn("", [12])).toBe("Depends-on: #12");
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

describe("parsePartOf", () => {
  it("returns undefined when there is no Part-of line", () => {
    expect(parsePartOf("Just a plain description.")).toBeUndefined();
  });

  it("parses a Part-of line", () => {
    expect(parsePartOf("Part-of: #40")).toBe(40);
  });

  it("is case-insensitive on the key", () => {
    expect(parsePartOf("part-of: #7")).toBe(7);
  });

  it("finds the line anywhere in a multi-line body", () => {
    const body = ["## Problem", "Some description.", "", "Part-of: #12", "", "## More"].join("\n");
    expect(parsePartOf(body)).toBe(12);
  });

  it("takes only the first reference when there are several", () => {
    expect(parsePartOf("Part-of: #12\nPart-of: #14")).toBe(12);
  });
});

describe("bodyWithPartOf", () => {
  it("leaves the body untouched when there is no epic", () => {
    expect(bodyWithPartOf("details", undefined)).toBe("details");
  });

  it("appends a Part-of line", () => {
    expect(bodyWithPartOf("details", 40)).toBe("details\n\nPart-of: #40");
  });

  it("doesn't leave a leading blank line when the body is empty", () => {
    expect(bodyWithPartOf("", 40)).toBe("Part-of: #40");
  });

  it("round-trips through parsePartOf", () => {
    expect(parsePartOf(bodyWithPartOf("details", 40))).toBe(40);
  });
});

describe("bodyWithChildTaskList / parseChildTaskList", () => {
  it("leaves the body untouched when there are no children", () => {
    expect(bodyWithChildTaskList("details", [])).toBe("details");
  });

  it("appends an unchecked task-list item per child", () => {
    const body = bodyWithChildTaskList("epic body", [
      { number: 41, title: "add the field" },
      { number: 42, title: "use the field" },
    ]);
    expect(body).toBe("epic body\n\n## Children\n- [ ] #41 add the field\n- [ ] #42 use the field");
  });

  it("doesn't leave a leading blank line when the body is empty", () => {
    expect(bodyWithChildTaskList("", [{ number: 41, title: "add the field" }])).toBe("## Children\n- [ ] #41 add the field");
  });

  it("round-trips through parseChildTaskList", () => {
    const body = bodyWithChildTaskList("epic body", [
      { number: 41, title: "add the field" },
      { number: 42, title: "use the field" },
    ]);
    expect(parseChildTaskList(body)).toEqual([
      { number: 41, checked: false },
      { number: 42, checked: false },
    ]);
  });

  it("returns [] when there is no Children section", () => {
    expect(parseChildTaskList("Just a plain description.")).toEqual([]);
  });

  it("reads a GitHub-checked item as closed", () => {
    const body = ["## Children", "- [x] #41 add the field", "- [ ] #42 use the field"].join("\n");
    expect(parseChildTaskList(body)).toEqual([
      { number: 41, checked: true },
      { number: 42, checked: false },
    ]);
  });

  it("is case-insensitive on the header and the checkbox letter", () => {
    const body = ["## children", "- [X] #41 add the field"].join("\n");
    expect(parseChildTaskList(body)).toEqual([{ number: 41, checked: true }]);
  });

  it("stops at the first non-list-item line after the section starts", () => {
    const body = ["## Children", "- [ ] #41 add the field", "", "## Unrelated", "more text"].join("\n");
    expect(parseChildTaskList(body)).toEqual([{ number: 41, checked: false }]);
  });
});

describe("toBoardTicket — epic linkage", () => {
  function fleetIssue(patch: Partial<{ number: number; title: string; body: string; labels: string[]; url: string }> = {}) {
    return {
      number: 7,
      title: "issue 7",
      body: "",
      labels: ["fleet:ready"],
      author: "collab-author",
      url: "https://github.com/acme/alpha/issues/7",
      ...patch,
    };
  }

  it("leaves a non-epic, non-child ticket unchanged", () => {
    const ticket = toBoardTicket(project, fleetIssue());
    expect(ticket?.epicNumber).toBeUndefined();
    expect(ticket?.epicProgress).toBeUndefined();
  });

  it("carries epicNumber for a child with a Part-of line", () => {
    const ticket = toBoardTicket(project, fleetIssue({ body: "Part-of: #40" }));
    expect(ticket?.epicNumber).toBe(40);
  });

  it("carries epicProgress for an epic with a Children task list", () => {
    const body = ["## Children", "- [x] #41 done child", "- [ ] #42 open child"].join("\n");
    const ticket = toBoardTicket(project, fleetIssue({ labels: ["fleet:review", "fleet:plan"], body }));
    expect(ticket?.epicProgress).toEqual({ closed: 1, total: 2 });
  });
});

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

describe("parseHeartbeat", () => {
  it("parses a well-formed heartbeat line", () => {
    const body = [
      "<!-- fleet-status -->",
      "<!-- fleet-heartbeat: 2026-01-01T00:00:00.000Z owner: daemon-a -->",
      "**Status: in progress**",
    ].join("\n");
    expect(parseHeartbeat(body)).toEqual({ timestamp: "2026-01-01T00:00:00.000Z", owner: "daemon-a" });
  });

  it("returns undefined when the body has no heartbeat line (a pre-heartbeat claim)", () => {
    expect(parseHeartbeat("<!-- fleet-status -->\n**Status: in progress**")).toBeUndefined();
  });

  it("returns undefined for a heartbeat line with an unparseable timestamp", () => {
    const body = "<!-- fleet-status -->\n<!-- fleet-heartbeat: not-a-date owner: daemon-a -->\nbody";
    expect(parseHeartbeat(body)).toBeUndefined();
  });
});

/** `getAuthenticatedLogin` caches its result at module scope for the process's lifetime — every test below shares this one login. */
function mockGhIdentity(login: string) {
  vi.mocked(exec.runJson).mockImplementation(async (_cmd, args) => {
    if ((args as string[]).includes("user")) return { login } as never;
    return [] as never;
  });
}

function statusComment(patch: Partial<{ id: number; body: string; created_at: string }> = {}) {
  return {
    id: 5,
    body: "<!-- fleet-status -->\nold body",
    user: { login: "daemon-a" },
    created_at: "2025-12-31T00:00:00.000Z",
    ...patch,
  };
}

describe("upsertStatusComment", () => {
  beforeEach(() => {
    mockGhIdentity("daemon-a");
    vi.mocked(exec.run).mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("posts a new comment stamped with a heartbeat for this daemon's login when none exists yet", async () => {
    await upsertStatusComment(project, 7, "**Status: running**");

    const call = vi.mocked(exec.run).mock.calls.find((c) => c[1]?.includes("comment"));
    const body = call?.[1]?.at(-1) ?? "";
    expect(body).toContain("<!-- fleet-status -->");
    expect(body).toMatch(/<!-- fleet-heartbeat: .+ owner: daemon-a -->/);
    expect(body).toContain("**Status: running**");
  });

  it("PATCHes the existing comment with a fresh heartbeat when one already exists", async () => {
    vi.mocked(exec.runJson).mockImplementation(async (_cmd, args) => {
      if ((args as string[]).includes("user")) return { login: "daemon-a" } as never;
      return [statusComment()] as never;
    });

    await upsertStatusComment(project, 7, "**Status: review**");

    expect(exec.run).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["-X", "PATCH"]),
    );
    const call = vi.mocked(exec.run).mock.calls.find((c) => c[1]?.includes("PATCH"));
    const body = call?.[1]?.at(-1) ?? "";
    expect(body).toContain("**Status: review**");
    expect(body).toMatch(/<!-- fleet-heartbeat: .+ owner: daemon-a -->/);
  });
});

describe("refreshHeartbeat", () => {
  beforeEach(() => {
    mockGhIdentity("daemon-a");
    vi.mocked(exec.run).mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("is a no-op when there is no status comment yet", async () => {
    await refreshHeartbeat(project, 7);
    expect(exec.run).not.toHaveBeenCalled();
  });

  it("unconditionally stamps a fresh heartbeat when a status comment exists, even a very recent one", async () => {
    const recentTs = new Date(Date.now() - 1_000).toISOString();
    vi.mocked(exec.runJson).mockImplementation(async (_cmd, args) => {
      if ((args as string[]).includes("user")) return { login: "daemon-a" } as never;
      return [statusComment({ body: `<!-- fleet-status -->\n<!-- fleet-heartbeat: ${recentTs} owner: daemon-a -->\nbody` })] as never;
    });

    await refreshHeartbeat(project, 7);

    expect(exec.run).toHaveBeenCalledWith("gh", expect.arrayContaining(["-X", "PATCH"]));
  });

  it("inserts a heartbeat line into a pre-heartbeat comment rather than skipping it", async () => {
    vi.mocked(exec.runJson).mockImplementation(async (_cmd, args) => {
      if ((args as string[]).includes("user")) return { login: "daemon-a" } as never;
      return [statusComment({ body: "<!-- fleet-status -->\n**Status: in progress**" })] as never;
    });

    await refreshHeartbeat(project, 7);

    const call = vi.mocked(exec.run).mock.calls.find((c) => c[1]?.includes("PATCH"));
    const body = call?.[1]?.at(-1) ?? "";
    expect(body).toMatch(/<!-- fleet-heartbeat: .+ owner: daemon-a -->/);
    expect(body).toContain("**Status: in progress**");
  });
});

describe("refreshHeartbeatIfStale", () => {
  beforeEach(() => {
    mockGhIdentity("daemon-a");
    vi.mocked(exec.run).mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("is a no-op when there is no status comment yet", async () => {
    await refreshHeartbeatIfStale(project, 7, 60_000);
    expect(exec.run).not.toHaveBeenCalled();
  });

  it("does not PATCH when the existing heartbeat is younger than maxAgeMs", async () => {
    const freshTs = new Date(Date.now() - 1_000).toISOString();
    vi.mocked(exec.runJson).mockImplementation(async (_cmd, args) => {
      if ((args as string[]).includes("user")) return { login: "daemon-a" } as never;
      return [statusComment({ body: `<!-- fleet-status -->\n<!-- fleet-heartbeat: ${freshTs} owner: daemon-a -->\nbody` })] as never;
    });

    await refreshHeartbeatIfStale(project, 7, 60_000);

    expect(exec.run).not.toHaveBeenCalled();
  });

  it("PATCHes with a fresh heartbeat once the existing one is older than maxAgeMs", async () => {
    const staleTs = new Date(Date.now() - 120_000).toISOString();
    vi.mocked(exec.runJson).mockImplementation(async (_cmd, args) => {
      if ((args as string[]).includes("user")) return { login: "daemon-a" } as never;
      return [statusComment({ body: `<!-- fleet-status -->\n<!-- fleet-heartbeat: ${staleTs} owner: daemon-a -->\nbody` })] as never;
    });

    await refreshHeartbeatIfStale(project, 7, 60_000);

    expect(exec.run).toHaveBeenCalledWith("gh", expect.arrayContaining(["-X", "PATCH"]));
  });

  it("treats a missing heartbeat line (pre-heartbeat comment) as stale", async () => {
    vi.mocked(exec.runJson).mockImplementation(async (_cmd, args) => {
      if ((args as string[]).includes("user")) return { login: "daemon-a" } as never;
      return [statusComment({ body: "<!-- fleet-status -->\n**Status: in progress**" })] as never;
    });

    await refreshHeartbeatIfStale(project, 7, 60_000);

    expect(exec.run).toHaveBeenCalledWith("gh", expect.arrayContaining(["-X", "PATCH"]));
  });
});

describe("getStatusCommentInfo", () => {
  it("returns undefined when there is no status comment", async () => {
    vi.mocked(exec.runJson).mockResolvedValue([]);
    expect(await getStatusCommentInfo(project, 7)).toBeUndefined();
  });

  it("returns the comment's creation time and parsed heartbeat when both are present", async () => {
    vi.mocked(exec.runJson).mockResolvedValue([
      statusComment({ body: "<!-- fleet-status -->\n<!-- fleet-heartbeat: 2026-01-01T00:00:00.000Z owner: daemon-a -->\nbody" }),
    ]);

    expect(await getStatusCommentInfo(project, 7)).toEqual({
      createdAt: "2025-12-31T00:00:00.000Z",
      heartbeat: { timestamp: "2026-01-01T00:00:00.000Z", owner: "daemon-a" },
    });
  });

  it("returns createdAt with an undefined heartbeat for a pre-heartbeat comment", async () => {
    vi.mocked(exec.runJson).mockResolvedValue([statusComment({ body: "<!-- fleet-status -->\nold-style body" })]);

    expect(await getStatusCommentInfo(project, 7)).toEqual({ createdAt: "2025-12-31T00:00:00.000Z", heartbeat: undefined });
  });
});
