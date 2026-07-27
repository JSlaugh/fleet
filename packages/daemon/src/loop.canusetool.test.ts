import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { FleetConfig, ProjectConfig } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "./approvals.ts";
import { FleetLoop } from "./loop.ts";
import { StateStore } from "./state.ts";

const project: ProjectConfig = {
  name: "alpha",
  repoPath: "/repo/alpha",
  githubRepo: "acme/alpha",
  defaultBranch: "main",
  maxConcurrent: 1,
  planChildrenReady: false,
  autoElevateOnFailure: true,
  autoAddressReviews: true,
  machineReview: true,
  model: "claude-sonnet-5",
};

function makeLoop(opts: { once?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "fleet-canusetool-"));
  const state = new StateStore(dataDir);
  const config: FleetConfig = {
    pollIntervalSeconds: 60,
    dashboardPort: 4400,
    worktreeRoot: "/tmp/wt",
    stalledAfterMinutes: 10,
    ticketTimeoutMinutes: 30,
    approvalTimeoutMinutes: 10,
    replyWaitMinutes: 60,
    limitResumeSlackMinutes: 5,
    limitDefaultBackoffMinutes: 300,
    dataDir,
    projects: [project],
  };
  const approvals = { request: vi.fn() } as unknown as ApprovalManager;
  const loop = new FleetLoop(config, state, dataDir, approvals, false, opts.once ?? false);
  const internals = loop as unknown as {
    makeCanUseTool: (p: ProjectConfig, issueNumber: number) => CanUseTool;
  };
  return { loop, approvals, canUseTool: internals.makeCanUseTool(project, 7) };
}

const options = { signal: new AbortController().signal, toolUseID: "tool-1" };

describe("makeCanUseTool in --once mode", () => {
  it("denies a permission request immediately instead of asking ApprovalManager", async () => {
    const { canUseTool, approvals } = makeLoop({ once: true });

    const result = await canUseTool("Bash", { command: "rm -rf /" }, options);

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") expect(result.message).toContain("--once mode");
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it("denies an AskUserQuestion immediately with blocked-status guidance", async () => {
    const { canUseTool, approvals } = makeLoop({ once: true });

    const result = await canUseTool("AskUserQuestion", { questions: [] }, options);

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("--once mode");
      expect(result.message).toContain('"blocked"');
    }
    expect(approvals.request).not.toHaveBeenCalled();
  });
});

describe("makeCanUseTool outside --once mode", () => {
  it("still routes through ApprovalManager", async () => {
    const { canUseTool, approvals } = makeLoop({ once: false });
    vi.mocked(approvals.request).mockResolvedValue({ allowed: true });

    const result = await canUseTool("Bash", { command: "ls" }, options);

    expect(approvals.request).toHaveBeenCalledOnce();
    expect(result.behavior).toBe("allow");
  });
});
