import type { FleetConfig, PlanResult, ProjectConfig, TicketRecord } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeCtx, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { readJournalTail } from "../store/journal.ts";
import { finishPlanned, PostCompletionError, resolveDependsOnIndex } from "./finish.ts";
import { FleetLoop } from "./loop.ts";

vi.mock("../github/github.ts", async (importActual) => ({
  ...(await importActual<typeof import("../github/github.ts")>()),
  createIssue: vi.fn(async () => ({ number: 1, url: "https://github.com/acme/alpha/issues/1" })),
  createPullRequest: vi.fn(async () => "https://github.com/acme/alpha/pull/7"),
  escalateToElevated: vi.fn(async () => {}),
  findChildIssues: vi.fn(async () => []),
  findOpenPrUrlForBranch: vi.fn(async () => undefined),
  getIssue: vi.fn(async () => ({ number: 7, title: "issue 7", body: "body", labels: [] })),
  getIssueComments: vi.fn(async () => []),
  getIssueLabels: vi.fn(async () => []),
  getPrState: vi.fn(),
  listFleetIssues: vi.fn(async () => []),
  markReady: vi.fn(async () => {}),
  swapLabel: vi.fn(async () => {}),
  toBoardTicket: vi.fn(),
  updateIssueBody: vi.fn(async () => {}),
  upsertStatusComment: vi.fn(async () => {}),
}));

vi.mock("../github/worktree.ts", () => ({
  createWorktree: vi.fn(),
  hasCommits: vi.fn(async () => true),
  pushBranch: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  collectBranchDiff: vi.fn(async () => ({ diff: "diff --git a b", commits: "abc123 fix" })),
}));

const github = await import("../github/github.ts");
const worktreeMod = await import("../github/worktree.ts");

const project = makeProject();

/** This file's ticket is issue 7 throughout; keep a local wrapper with those defaults over the shared factory. */
function record(patch: Partial<TicketRecord> = {}): TicketRecord {
  return makeRecord({
    issueNumber: 7,
    issueTitle: "issue 7",
    branch: "fleet/7",
    worktreePath: "/tmp/wt/7",
    sessionId: "sess-7",
    costUsd: 3,
    ...patch,
  });
}

const issue = { number: 7, title: "issue 7", body: "body", labels: [] };

function makeLoop(seed?: TicketRecord, configPatch: Partial<FleetConfig> = {}) {
  const { dataDir, state } = makeTempState("fleet-finish-");
  if (seed) state.upsert(seed);
  const config = makeFleetConfig({ dataDir, projects: [project], ...configPatch });
  const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
  const internals = loop as unknown as {
    finishCompleted: (
      p: ProjectConfig,
      i: typeof issue,
      worktreePath: string,
      branch: string,
      summary: string,
      result: { prTitle?: string; prBody?: string; filesChanged: string[]; confidence: string },
    ) => Promise<void>;
    finishBlocked: (p: ProjectConfig, i: typeof issue, reason: string, summary?: string) => Promise<void>;
    finishFailed: (p: ProjectConfig, i: typeof issue, error: string, opts?: { postCompletion?: boolean }) => Promise<void>;
  };
  return { loop, state, internals };
}

const completedResult = { prTitle: "Fix the thing", prBody: "It's fixed.", filesChanged: ["src/a.ts"], confidence: "high" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(worktreeMod.hasCommits).mockResolvedValue(true);
  vi.mocked(worktreeMod.pushBranch).mockResolvedValue(undefined);
  vi.mocked(github.createPullRequest).mockResolvedValue("https://github.com/acme/alpha/pull/7");
  vi.mocked(github.swapLabel).mockResolvedValue(undefined);
  vi.mocked(github.upsertStatusComment).mockResolvedValue(undefined);
  vi.mocked(github.getIssue).mockResolvedValue({ number: 7, title: "issue 7", body: "body", labels: [] });
  vi.mocked(github.findChildIssues).mockResolvedValue([]);
  vi.mocked(github.findOpenPrUrlForBranch).mockResolvedValue(undefined);
});

describe("finishCompleted — status comment error policy", () => {
  it("still reaches fleet:review and records the PR when the status comment fails", async () => {
    vi.mocked(github.upsertStatusComment).mockRejectedValue(new Error("gh: rate limited"));
    const { state, internals } = makeLoop(record());

    await internals.finishCompleted(project, issue, "/tmp/wt/7", "fleet/7", "did the thing", completedResult);

    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:review");
    const updated = state.get("alpha", 7);
    expect(updated?.status).toBe("review");
    expect(updated?.prUrl).toBe("https://github.com/acme/alpha/pull/7");
  });

  it("posts the review status comment and swaps the label on the happy path", async () => {
    const { state, internals } = makeLoop(record());

    await internals.finishCompleted(project, issue, "/tmp/wt/7", "fleet/7", "did the thing", completedResult);

    expect(github.upsertStatusComment).toHaveBeenCalledOnce();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:review");
    expect(state.get("alpha", 7)?.status).toBe("review");
  });
});

describe("finishCompleted — post-completion pipeline failures", () => {
  it("wraps a push rejection in a PostCompletionError instead of a plain error", async () => {
    vi.mocked(worktreeMod.pushBranch).mockRejectedValue(
      new Error("git -C /tmp/wt/7 push -u origin fleet/7 failed (exit 1): ! [rejected] fleet/7 -> fleet/7 (non-fast-forward)"),
    );
    const { internals } = makeLoop(record());

    const failure = await internals
      .finishCompleted(project, issue, "/tmp/wt/7", "fleet/7", "did the thing", completedResult)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(PostCompletionError);
    expect((failure as Error).message).toContain("commits exist on `fleet/7`");
    expect((failure as Error).message).toContain("non-fast-forward");
    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("wraps a gh pr create failure in a PostCompletionError", async () => {
    vi.mocked(github.createPullRequest).mockRejectedValue(
      new Error("gh pr create --repo acme/alpha ... failed (exit 1): GraphQL: something went wrong"),
    );
    const { internals } = makeLoop(record());

    const failure = await internals
      .finishCompleted(project, issue, "/tmp/wt/7", "fleet/7", "did the thing", completedResult)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(PostCompletionError);
    expect((failure as Error).message).toContain("something went wrong");
    expect(github.swapLabel).not.toHaveBeenCalled();
  });

  it("adopts the existing open PR when gh pr create reports one already exists for the branch", async () => {
    vi.mocked(github.createPullRequest).mockRejectedValue(
      new Error('gh pr create failed (exit 1): a pull request for branch "fleet/7" already exists'),
    );
    vi.mocked(github.findOpenPrUrlForBranch).mockResolvedValue("https://github.com/acme/alpha/pull/9");
    const { state, internals } = makeLoop(record());

    await internals.finishCompleted(project, issue, "/tmp/wt/7", "fleet/7", "did the thing", completedResult);

    expect(state.get("alpha", 7)?.prUrl).toBe("https://github.com/acme/alpha/pull/9");
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:review");
  });

  it("persists prUrl before the label swap, so a swap failure can't orphan the created PR", async () => {
    vi.mocked(github.swapLabel).mockRejectedValue(new Error("gh: rate limited"));
    const { state, internals } = makeLoop(record());

    await internals
      .finishCompleted(project, issue, "/tmp/wt/7", "fleet/7", "did the thing", completedResult)
      .catch(() => undefined);

    expect(state.get("alpha", 7)?.prUrl).toBe("https://github.com/acme/alpha/pull/7");
  });
});

describe("finishBlocked — status comment error policy", () => {
  it("still reaches fleet:needs-input when the status comment fails", async () => {
    vi.mocked(github.upsertStatusComment).mockRejectedValue(new Error("gh: rate limited"));
    const { state, internals } = makeLoop(record());

    await internals.finishBlocked(project, issue, "need the API key", "summary");

    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    expect(state.get("alpha", 7)?.status).toBe("needs-input");
  });
});

describe("finishFailed — auto-elevation", () => {
  it("journals an auto-elevated fleet event when escalating", async () => {
    const elevatingProject = makeProject({ elevatedModel: "claude-opus-5" });
    const { dataDir, state } = makeTempState("fleet-finish-elevate-");
    state.upsert(record({ model: "claude-sonnet-5" }));
    const config = makeFleetConfig({ dataDir, projects: [elevatingProject] });
    const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
    const internals = loop as unknown as {
      finishFailed: (p: ProjectConfig, i: typeof issue, error: string) => Promise<void>;
    };

    await internals.finishFailed(elevatingProject, issue, "the model gave up");

    const entries = readJournalTail(dataDir, "alpha", 7, 10);
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: "fleet",
        event: "auto-elevated",
        fromModel: "claude-sonnet-5",
        toModel: "claude-opus-5",
        error: "the model gave up",
      }),
    );
  });
});

describe("resolveDependsOnIndex", () => {
  it("returns no dependencies when dependsOnIndex is absent or empty", () => {
    expect(resolveDependsOnIndex(2, undefined, 3)).toEqual({ valid: [], dropped: [] });
    expect(resolveDependsOnIndex(2, [], 3)).toEqual({ valid: [], dropped: [] });
  });

  it("resolves references to strictly earlier indices (happy path)", () => {
    expect(resolveDependsOnIndex(2, [0, 1], 3)).toEqual({ valid: [0, 1], dropped: [] });
  });

  it("drops a self reference", () => {
    expect(resolveDependsOnIndex(1, [1], 3)).toEqual({ valid: [], dropped: [1] });
  });

  it("drops a forward reference", () => {
    expect(resolveDependsOnIndex(0, [1], 3)).toEqual({ valid: [], dropped: [1] });
  });

  it("drops an out-of-range index", () => {
    expect(resolveDependsOnIndex(2, [-1, 5], 3)).toEqual({ valid: [], dropped: [-1, 5] });
  });

  it("dedupes a repeated valid index", () => {
    expect(resolveDependsOnIndex(2, [1, 0, 1], 3)).toEqual({ valid: [1, 0], dropped: [] });
  });
});

describe("finishPlanned — dependsOnIndex translation", () => {
  const planIssue = { number: 7, title: "epic 7", body: "body", labels: [], author: "collab-author", assignees: [] };

  beforeEach(() => {
    let nextNumber = 100;
    vi.mocked(github.createIssue).mockImplementation(async () => {
      nextNumber += 1;
      return { number: nextNumber, url: `https://github.com/acme/alpha/issues/${nextNumber}` };
    });
  });

  it("files children in order and appends a Depends-on line with the real sibling issue number", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = {
      status: "completed",
      summary: "epic summary",
      confidence: "high",
      tickets: [
        { title: "add the schema field", body: "add it" },
        { title: "use it in the dashboard", body: "use it", dependsOnIndex: [0] },
      ],
    };

    await finishPlanned(ctx, project, planIssue, result);

    const calls = vi.mocked(github.createIssue).mock.calls;
    expect(calls[0]?.[1]?.body).toBe("add it\n\nPart-of: #7");
    expect(calls[1]?.[1]?.body).toBe("use it\n\nPart-of: #7\n\nDepends-on: #101");
  });

  it("files children into fleet:backlog by default so they show on the board without being claimable", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = {
      status: "completed",
      summary: "epic summary",
      confidence: "high",
      tickets: [{ title: "child", body: "body", tier: "light" }],
    };

    await finishPlanned(ctx, project, planIssue, result);

    expect(vi.mocked(github.createIssue).mock.calls[0]?.[1]?.labels).toEqual(["fleet:light", "fleet:backlog"]);
    expect(github.upsertStatusComment).toHaveBeenCalledWith(project, 7, expect.stringContaining("Accept plan"));
  });

  it("files children straight into fleet:ready when the project sets planChildrenReady", async () => {
    const readyProject = makeProject({ planChildrenReady: true });
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [readyProject] }) });
    ctx.state.upsert(record());
    const result: PlanResult = {
      status: "completed",
      summary: "epic summary",
      confidence: "high",
      tickets: [{ title: "child", body: "body" }],
    };

    await finishPlanned(ctx, readyProject, planIssue, result);

    expect(vi.mocked(github.createIssue).mock.calls[0]?.[1]?.labels).toEqual(["fleet:ready"]);
  });

  it("drops an out-of-range/self/forward dependsOnIndex, files the rest normally, and notes it in the status comment", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = {
      status: "completed",
      summary: "epic summary",
      confidence: "high",
      tickets: [{ title: "first", body: "first body", dependsOnIndex: [0, 1, 5] }],
    };

    await finishPlanned(ctx, project, planIssue, result);

    expect(vi.mocked(github.createIssue).mock.calls[0]?.[1]?.body).toBe("first body\n\nPart-of: #7");
    expect(github.upsertStatusComment).toHaveBeenCalledWith(
      project,
      7,
      expect.stringContaining("Dropped invalid dependencies"),
    );
  });
});

describe("finishPlanned — epic linkage", () => {
  const planIssue = { number: 7, title: "epic 7", body: "epic body", labels: [], author: "collab-author", assignees: [] };

  beforeEach(() => {
    let nextNumber = 100;
    vi.mocked(github.createIssue).mockImplementation(async () => {
      nextNumber += 1;
      return { number: nextNumber, url: `https://github.com/acme/alpha/issues/${nextNumber}` };
    });
    // The Children stamp re-reads the live epic body before overwriting it.
    vi.mocked(github.getIssue).mockResolvedValue({ number: 7, title: "epic 7", body: "epic body", labels: [] });
    vi.mocked(github.findChildIssues).mockResolvedValue([]);
  });

  it("stamps a Part-of line onto every filed child", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = {
      status: "completed",
      summary: "epic summary",
      confidence: "high",
      tickets: [
        { title: "add the schema field", body: "add it" },
        { title: "use it in the dashboard", body: "use it" },
      ],
    };

    await finishPlanned(ctx, project, planIssue, result);

    const calls = vi.mocked(github.createIssue).mock.calls;
    expect(calls[0]?.[1]?.body).toBe("add it\n\nPart-of: #7");
    expect(calls[1]?.[1]?.body).toBe("use it\n\nPart-of: #7");
  });

  it("combines Part-of and Depends-on on the same child body", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = {
      status: "completed",
      summary: "epic summary",
      confidence: "high",
      tickets: [
        { title: "add the schema field", body: "add it" },
        { title: "use it in the dashboard", body: "use it", dependsOnIndex: [0] },
      ],
    };

    await finishPlanned(ctx, project, planIssue, result);

    const calls = vi.mocked(github.createIssue).mock.calls;
    expect(calls[1]?.[1]?.body).toBe("use it\n\nPart-of: #7\n\nDepends-on: #101");
  });

  it("skips filing entirely when the live epic body already carries a Children list", async () => {
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 7,
      title: "epic 7",
      body: "epic body\n\n## Children\n- [ ] #41 earlier child",
      labels: [],
    });
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = { status: "completed", summary: "epic summary", confidence: "high", tickets: [{ title: "a", body: "b" }] };

    await finishPlanned(ctx, project, planIssue, result);

    expect(github.createIssue).not.toHaveBeenCalled();
    expect(github.updateIssueBody).not.toHaveBeenCalled();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:review");
  });

  it("skips filing when Part-of children exist even though the Children stamp never landed", async () => {
    vi.mocked(github.findChildIssues).mockResolvedValue([41, 42]);
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = { status: "completed", summary: "epic summary", confidence: "high", tickets: [{ title: "a", body: "b" }] };

    await finishPlanned(ctx, project, planIssue, result);

    expect(github.createIssue).not.toHaveBeenCalled();
  });

  it("skips the Children stamp (never overwrites blind) when the live epic body can't be re-read", async () => {
    vi.mocked(github.getIssue).mockResolvedValue(undefined);
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = { status: "completed", summary: "epic summary", confidence: "high", tickets: [{ title: "a", body: "b" }] };

    await finishPlanned(ctx, project, planIssue, result);

    expect(github.createIssue).toHaveBeenCalledOnce();
    expect(github.updateIssueBody).not.toHaveBeenCalled();
    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:review");
  });

  it("stamps a Children task list onto the epic body once children are filed", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = {
      status: "completed",
      summary: "epic summary",
      confidence: "high",
      tickets: [
        { title: "add the schema field", body: "add it" },
        { title: "use it in the dashboard", body: "use it" },
      ],
    };

    await finishPlanned(ctx, project, planIssue, result);

    expect(github.updateIssueBody).toHaveBeenCalledWith(
      project,
      7,
      "epic body\n\n## Children\n- [ ] #101 add the schema field\n- [ ] #102 use it in the dashboard",
    );
  });

  it("does not touch the epic body when no children were filed", async () => {
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = { status: "completed", summary: "epic summary", confidence: "high", tickets: [] };

    await finishPlanned(ctx, project, planIssue, result);

    expect(github.updateIssueBody).not.toHaveBeenCalled();
  });

  it("still reaches fleet:review when stamping the Children task list fails", async () => {
    vi.mocked(github.updateIssueBody).mockRejectedValueOnce(new Error("gh: rate limited"));
    const ctx = makeCtx({ config: makeFleetConfig({ projects: [project] }) });
    ctx.state.upsert(record());
    const result: PlanResult = {
      status: "completed",
      summary: "epic summary",
      confidence: "high",
      tickets: [{ title: "add the schema field", body: "add it" }],
    };

    await finishPlanned(ctx, project, planIssue, result);

    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:review");
  });
});

describe("Discord notifications", () => {
  const notifications = { discordUrl: "https://discord.example/webhook" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a needs-input notification when a ticket blocks", async () => {
    const { internals } = makeLoop(record(), { notifications });

    await internals.finishBlocked(project, issue, "need the API key", "summary");

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain("Needs input");
    expect(body.content).toContain("need the API key");
  });

  it("posts a pr-opened notification once the PR is created", async () => {
    const { internals } = makeLoop(record(), { notifications });

    await internals.finishCompleted(project, issue, "/tmp/wt/7", "fleet/7", "did the thing", completedResult);

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain("PR opened");
    expect(body.content).toContain("https://github.com/acme/alpha/pull/7");
  });

  it("posts a needs-input notification for a post-completion pipeline failure", async () => {
    const { internals } = makeLoop(record(), { notifications });

    await internals.finishFailed(project, issue, "push rejected", { postCompletion: true });

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain("Needs input");
  });

  it("posts a failed notification for a terminal run failure (no elevated model to retry on)", async () => {
    const { internals } = makeLoop(record(), { notifications });

    await internals.finishFailed(project, issue, "the model gave up");

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain("Failed");
  });

  it("does not notify without notifications configured", async () => {
    const { internals } = makeLoop(record());

    await internals.finishBlocked(project, issue, "need the API key", "summary");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("a rejecting webhook never affects the needs-input ticket path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, internals } = makeLoop(record(), { notifications });

    await internals.finishBlocked(project, issue, "need the API key", "summary");

    expect(github.swapLabel).toHaveBeenCalledWith(project, 7, "fleet:in-progress", "fleet:needs-input");
    expect(state.get("alpha", 7)?.status).toBe("needs-input");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
