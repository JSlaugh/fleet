/**
 * Shared factories for the daemon test suite. Every fixture starts from one of
 * these and patches only what the test actually cares about — never hand-roll a
 * full ProjectConfig / FleetConfig / TicketRecord / LoopContext literal in a
 * test file. Duplicated literals make every schema change fan out across the
 * whole suite, and two branches doing that concurrently has broken main's
 * typecheck before (each passed alone, their merge didn't).
 *
 * Defaults here mirror the values the suite historically used everywhere:
 * project "alpha" at acme/alpha, issue 62 on branch fleet/62.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { FleetConfig, ProjectConfig, TicketRecord } from "@fleet/shared";
import type { ReadyIssue } from "./github/github.ts";
import type { LoopContext } from "./loop/context.ts";
import type { ApprovalManager } from "./session/approvals.ts";
import { HistoryStore, StateStore } from "./store/state.ts";

export function makeProject(patch: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
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
    ...patch,
  };
}

export function makeFleetConfig(patch: Partial<FleetConfig> = {}): FleetConfig {
  return {
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
    dataDir: ".fleet",
    projects: [makeProject()],
    ...patch,
  };
}

export function makeIssue(
  number: number,
  labels: string[] = ["fleet:ready"],
  patch: Partial<ReadyIssue> = {},
): ReadyIssue & { url: string } {
  return {
    number,
    title: `issue ${number}`,
    body: "",
    labels,
    url: `https://github.com/acme/alpha/issues/${number}`,
    ...patch,
  };
}

export function makeRecord(patch: Partial<TicketRecord> = {}): TicketRecord {
  return {
    project: "alpha",
    issueNumber: 62,
    issueTitle: "issue 62",
    branch: "fleet/62",
    worktreePath: "/tmp/wt/62",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    costUsd: 0,
    ...patch,
  };
}

/** A StateStore backed by a fresh temp dir (the OS owns cleanup, as the suite has always assumed). */
export function makeTempState(prefix = "fleet-test-"): { dataDir: string; state: StateStore } {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  return { dataDir, state: new StateStore(dataDir) };
}

export function makeApprovals(): ApprovalManager {
  return { request: vi.fn(), list: vi.fn(() => []) } as unknown as ApprovalManager;
}

/** POSTs a JSON body to a Hono test app — the fetch boilerplate every server test repeats. */
export function postJson(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  path: string,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * A complete LoopContext with real temp-dir stores and empty in-flight
 * collections. Patch whatever the test steers: pass `config` to change
 * projects (getProject reads the final config either way), or e.g.
 * `isShuttingDown: () => true` to simulate a mid-cycle shutdown.
 */
export function makeCtx(patch: Partial<LoopContext> = {}): LoopContext {
  const dataDir = patch.dataDirPath ?? mkdtempSync(join(tmpdir(), "fleet-ctx-"));
  const config = patch.config ?? makeFleetConfig({ dataDir });
  return {
    config,
    state: patch.state ?? new StateStore(dataDir),
    history: patch.history ?? new HistoryStore(dataDir),
    dataDirPath: dataDir,
    approvals: makeApprovals(),
    dryRun: false,
    once: false,
    running: new Map(),
    live: new Map(),
    restarting: new Set(),
    stopping: new Set(),
    replyWaiters: new Map(),
    boardCache: new Map(),
    emitBoard: () => {},
    getProject: (name) => config.projects.find((p) => p.name === name),
    isShuttingDown: () => false,
    ...patch,
  };
}
