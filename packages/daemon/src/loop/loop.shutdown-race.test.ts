import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import { cycleProject } from "./claim.ts";
import type { LoopContext } from "./context.ts";
import { recoverStalled } from "./recovery.ts";
import { addressReviews } from "./reviews.ts";
import { StateStore } from "../store/state.ts";

// These exercise the exact race the daemon-shutdown review flagged: `cycle()`
// snapshots `paused` once at the top of a cycle and threads it through several
// awaited GitHub calls, so a shutdown requested mid-cycle wouldn't be seen by
// the time `cycleProject`/`recoverStalled`/`addressReviews` reach the point of
// tracking new work — unless each checks a *live* `ctx.isShuttingDown()`
// right before doing so (added in claim.ts/recovery.ts/reviews.ts).

vi.mock("../github/github.ts", async (importActual) => ({
	...(await importActual<typeof import("../github/github.ts")>()),
	createPullRequest: vi.fn(),
	getIssueComments: vi.fn(async () => []),
	getIssueLabels: vi.fn(async () => []),
	getPrFeedback: vi.fn(async () => ({
		hasChangesRequested: true,
		reviews: [],
		comments: [],
		latestAt: "2026-01-02T00:00:00.000Z",
	})),
	getPrMergeable: vi.fn(async () => "MERGEABLE"),
	getPrState: vi.fn(),
	listFleetIssues: vi.fn(async () => [
		{ number: 7, title: "issue 7", body: "", labels: ["fleet:ready"] },
	]),
	listIssueStates: vi.fn(async () => ({
		open: new Set([7]),
		all: new Set([7]),
	})),
	markReady: vi.fn(async () => {}),
	swapLabel: vi.fn(async () => {}),
	toBoardTicket: vi.fn(() => null),
	upsertStatusComment: vi.fn(async () => {}),
}));

// `processTicket`/`resumeTicket` reaching `createWorktree`/`WorkerSession` for
// real would spawn actual git commands and an Agent SDK session; rejecting
// fast is enough since these tests only care whether `track()` was reached at
// all, not what the tracked run subsequently does with it.
vi.mock("../github/worktree.ts", () => ({
	createWorktree: vi.fn(async () => {
		throw new Error("not exercised by this test");
	}),
}));

const github = await import("../github/github.ts");

const project: ProjectConfig = {
	name: "alpha",
	repoPath: "/repo/alpha",
	githubRepo: "acme/alpha",
	maxInReview: 3,
	defaultBranch: "main",
	maxConcurrent: 2,
	planChildrenReady: false,
	autoElevateOnFailure: true,
	autoAddressReviews: true,
	machineReview: false,
	autoMerge: false,
	mergeMethod: "squash",
};

function record(patch: Partial<TicketRecord> = {}): TicketRecord {
	return {
		project: "alpha",
		issueNumber: 7,
		issueTitle: "issue 7",
		branch: "fleet/7",
		worktreePath: "/tmp/wt/7",
		sessionId: "sess-7",
		status: "stalled",
		startedAt: "2026-01-01T00:00:00.000Z",
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		costUsd: 1,
		prUrl: "https://github.com/acme/alpha/pull/7",
		...patch,
	};
}

/** A minimal, hand-built `LoopContext` — no `FleetLoop` needed since these test plain functions that take it directly. */
function makeCtx(
	shuttingDown: boolean,
	seed?: TicketRecord,
): { ctx: LoopContext; state: StateStore } {
	const dataDir = mkdtempSync(join(tmpdir(), "fleet-shutdown-race-"));
	const state = new StateStore(dataDir);
	if (seed) state.upsert(seed);
	const ctx: LoopContext = {
		config: {
			pollIntervalSeconds: 60,
			dashboardPort: 4400,
			worktreeRoot: "/tmp/wt",
			stalledAfterMinutes: 10,
			ticketTimeoutMinutes: 30,
			approvalTimeoutMinutes: 10,
			replyWaitMinutes: 60,
			limitResumeSlackMinutes: 5,
			limitDefaultBackoffMinutes: 300,
			usageWindowHours: 5,
			budgetLightThreshold: 0.85,
			dataDir,
			projects: [project],
		},
		state,
		history: undefined as never,
		dataDirPath: dataDir,
		approvals: { request: vi.fn() } as unknown as ApprovalManager,
		dryRun: false,
		once: false,
		running: new Map(),
		live: new Map(),
		restarting: new Set(),
		stopping: new Set(),
		replyWaiters: new Map(),
		boardCache: new Map(),
		emitBoard: () => {},
		getProject: (name) => (name === "alpha" ? project : undefined),
		isShuttingDown: () => shuttingDown,
	};
	return { ctx, state };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("cycleProject claiming vs. a live shutdown", () => {
	it("tracks a fresh claim when not shutting down", async () => {
		const { ctx } = makeCtx(false);
		await cycleProject(ctx, project);
		expect(ctx.running.has("alpha#7")).toBe(true);
	});

	it("does not claim once isShuttingDown() is true, even though `paused` is still false", async () => {
		const { ctx } = makeCtx(true);
		await cycleProject(ctx, project);
		expect(ctx.running.size).toBe(0);
		expect(github.swapLabel).not.toHaveBeenCalled();
	});
});

describe("recoverStalled vs. a live shutdown", () => {
	it("auto-resumes a stalled ticket when not shutting down", () => {
		const { ctx } = makeCtx(false, record());
		recoverStalled(ctx);
		expect(ctx.running.has("alpha#7")).toBe(true);
	});

	it("does not auto-resume once isShuttingDown() is true", () => {
		const { ctx, state } = makeCtx(true, record());
		recoverStalled(ctx);
		expect(ctx.running.size).toBe(0);
		// Left exactly as found — not consumed as if it had been auto-resumed.
		expect(state.get("alpha", 7)?.autoResumed).toBeFalsy();
	});
});

describe("addressReviews vs. a live shutdown", () => {
	it("resumes a review-feedback candidate when not shutting down", async () => {
		const { ctx } = makeCtx(false, record({ status: "review" }));
		await addressReviews(ctx, project, new Set([7]));
		expect(ctx.running.has("alpha#7")).toBe(true);
	});

	it("does not resume once isShuttingDown() is true", async () => {
		const { ctx } = makeCtx(true, record({ status: "review" }));
		await addressReviews(ctx, project, new Set([7]));
		expect(ctx.running.size).toBe(0);
		expect(github.swapLabel).not.toHaveBeenCalled();
	});
});
