import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { PostCompletionError } from "./finish.ts";
import { FleetLoop } from "./loop.ts";

vi.mock("../github/github.ts", () => ({
  createPullRequest: vi.fn(async () => "https://github.com/acme/alpha/pull/7"),
  escalateToElevated: vi.fn(async () => {}),
  getIssueComments: vi.fn(async () => []),
  getIssueLabels: vi.fn(async () => []),
  getPrState: vi.fn(),
  listFleetIssues: vi.fn(async () => []),
  markReady: vi.fn(async () => {}),
  swapLabel: vi.fn(async () => {}),
  toBoardTicket: vi.fn(),
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
      new Error("gh pr create --repo acme/alpha ... failed (exit 1): pull request create failed: a pull request for branch \"fleet/7\" already exists"),
    );
    const { internals } = makeLoop(record());

    const failure = await internals
      .finishCompleted(project, issue, "/tmp/wt/7", "fleet/7", "did the thing", completedResult)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(PostCompletionError);
    expect((failure as Error).message).toContain("already exists");
    expect(github.swapLabel).not.toHaveBeenCalled();
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
