import type { ProjectConfig, TicketRecord } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import { makeApprovals, makeFleetConfig, makeProject, makeRecord, makeTempState } from "../test-support.ts";
import { FleetLoop } from "./loop.ts";

vi.mock("../github/github.ts", () => ({
	createPullRequest: vi.fn(),
	getIssueComments: vi.fn(async () => []),
	getIssueLabels: vi.fn(async () => []),
	getPrState: vi.fn(),
	listFleetIssues: vi.fn(async () => []),
	markReady: vi.fn(async () => {}),
	swapLabel: vi.fn(async () => {}),
	toBoardTicket: vi.fn(),
	upsertStatusComment: vi.fn(async () => {}),
}));

const github = await import("../github/github.ts");

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
		sessionLive: true,
		autoResumed: true,
		...patch,
	});
}

function makeLoop(seed?: TicketRecord) {
	const { dataDir, state } = makeTempState("fleet-shutdown-");
	if (seed) state.upsert(seed);
	const config = makeFleetConfig({ dataDir, projects: [project] });
	const loop = new FleetLoop(config, state, dataDir, makeApprovals(), false);
	const internals = loop as unknown as {
		live: Map<
			string,
			{ abortController: AbortController; sessionId?: string }
		>;
		running: Map<string, Promise<void>>;
		replyWaiters: Map<string, (message: string | undefined) => void>;
		finishFailed: (
			p: ProjectConfig,
			issue: { number: number; title: string },
			error: string,
		) => Promise<void>;
	};
	return { loop, state, dataDir, internals };
}

describe("beginShutdown", () => {
	it("only the first caller wins", () => {
		const { loop } = makeLoop();
		expect(loop.isShuttingDown).toBe(false);
		expect(loop.beginShutdown()).toBe(true);
		expect(loop.isShuttingDown).toBe(true);
		expect(loop.beginShutdown()).toBe(false);
	});
});

describe("shutdownDrain", () => {
	it("pauses the daemon and resolves once every running ticket settles", async () => {
		const { loop, state, internals } = makeLoop(record());
		let resolveRun: (() => void) | undefined;
		internals.running.set(
			"alpha#7",
			new Promise<void>((resolve) => {
				resolveRun = resolve;
			}),
		);

		const draining = loop.shutdownDrain();
		expect(state.getPaused()).toBe(true);

		let settled = false;
		void draining.then(() => (settled = true));
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);

		resolveRun?.();
		await draining;
		expect(settled).toBe(true);
	});

	it("resolves immediately when nothing is running", async () => {
		const { loop, state } = makeLoop();
		await loop.shutdownDrain();
		expect(state.getPaused()).toBe(true);
	});
});

describe("shutdownNow", () => {
	it("aborts every live session and waits for the run to unwind", async () => {
		const { loop, state, internals } = makeLoop(record());
		const abortController = new AbortController();
		internals.live.set("alpha#7", { abortController, sessionId: "sess-7" });
		let unwound = false;
		internals.running.set(
			"alpha#7",
			new Promise<void>((resolve) => {
				abortController.signal.addEventListener("abort", () => {
					// Stand in for `finishFailed`'s `stopping` guard, which leaves the
					// ticket stalled with its session id intact and autoResumed cleared.
					state.update("alpha", 7, {
						status: "stalled",
						autoResumed: false,
					});
					unwound = true;
					resolve();
				});
			}),
		);

		await loop.shutdownNow();

		expect(abortController.signal.aborted).toBe(true);
		expect(unwound).toBe(true);
		const updated = state.get("alpha", 7);
		expect(updated?.status).toBe("stalled");
		expect(updated?.sessionId).toBe("sess-7");
		expect(updated?.autoResumed).toBe(false);
	});

	it("releases a session parked awaiting a reply so it does not wait out replyWaitMinutes", async () => {
		const { loop, internals } = makeLoop(record({ status: "needs-input" }));
		const abortController = new AbortController();
		internals.live.set("alpha#7", { abortController });
		const parked = new Promise<string | undefined>((resolve) => {
			internals.replyWaiters.set("alpha#7", resolve);
		});
		internals.running.set(
			"alpha#7",
			parked.then(() => undefined),
		);

		await loop.shutdownNow();

		await expect(parked).resolves.toBeUndefined();
	});

	it("does not post a failure status comment or swap labels for the aborted turn", async () => {
		const { loop, state, internals } = makeLoop(record());
		const abortController = new AbortController();
		internals.live.set("alpha#7", { abortController });
		internals.running.set(
			"alpha#7",
			new Promise<void>((resolve) => {
				abortController.signal.addEventListener("abort", () => {
					void internals
						.finishFailed(
							project,
							{ number: 7, title: "issue 7" },
							"timed out after 30 minutes",
						)
						.then(resolve);
				});
			}),
		);

		await loop.shutdownNow();

		expect(github.swapLabel).not.toHaveBeenCalled();
		expect(github.upsertStatusComment).not.toHaveBeenCalled();
		expect(state.get("alpha", 7)?.status).toBe("stalled");
		expect(state.get("alpha", 7)?.autoResumed).toBe(false);
	});

	it("does nothing when no sessions are live", async () => {
		const { loop } = makeLoop();
		await expect(loop.shutdownNow()).resolves.toBeUndefined();
	});

	it("gives up on a wedged session after the drain window but keeps suppressing its failure until it truly unwinds", async () => {
		vi.useFakeTimers();
		try {
			const { loop, state, internals } = makeLoop(record());
			const abortController = new AbortController();
			internals.live.set("alpha#7", { abortController });
			let settle: (() => void) | undefined;
			internals.running.set(
				"alpha#7",
				new Promise<void>((resolve) => (settle = resolve)),
			);

			const stopping = loop.shutdownNow();
			await vi.advanceTimersByTimeAsync(30_000);
			await stopping;

			expect(abortController.signal.aborted).toBe(true);

			// The wedged session's eventual error must still be suppressed and left stalled.
			await internals.finishFailed(
				project,
				{ number: 7, title: "issue 7" },
				"wedged",
			);
			expect(github.swapLabel).not.toHaveBeenCalled();
			expect(state.get("alpha", 7)?.status).toBe("stalled");
			expect(state.get("alpha", 7)?.autoResumed).toBe(false);

			settle?.();
			await vi.advanceTimersByTimeAsync(0);

			// Once the run has truly unwound, a later failure reports normally.
			await internals.finishFailed(
				project,
				{ number: 7, title: "issue 7" },
				"later failure",
			);
			expect(github.swapLabel).toHaveBeenCalledWith(
				project,
				7,
				"fleet:in-progress",
				"fleet:needs-input",
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
