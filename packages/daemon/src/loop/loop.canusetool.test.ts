import type { FleetConfig, ProjectConfig } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalManager } from "../session/approvals.ts";
import type { LoopContext } from "./context.ts";
import { makeCanUseTool } from "./runner.ts";

const project: ProjectConfig = {
  name: "alpha",
  repoPath: "/repo/alpha",
  githubRepo: "acme/alpha",
  defaultBranch: "main",
  maxConcurrent: 1,
  maxInReview: 3,
  planChildrenReady: false,
  autoElevateOnFailure: true,
  autoAddressReviews: true,
  machineReview: true,
  model: "claude-sonnet-5",
};

function makeCtx(opts: { once?: boolean } = {}) {
  const approvals = { request: vi.fn() } as unknown as ApprovalManager;
  const ctx = {
    config: { approvalTimeoutMinutes: 10 } as FleetConfig,
    approvals,
    once: opts.once ?? false,
  } as unknown as LoopContext;
  return { approvals, canUseTool: makeCanUseTool(ctx, project, 7) };
}

const options = { signal: new AbortController().signal, toolUseID: "tool-1" };

describe("makeCanUseTool in --once mode", () => {
  it("denies a permission request immediately instead of asking ApprovalManager", async () => {
    const { canUseTool, approvals } = makeCtx({ once: true });

    const result = await canUseTool("Bash", { command: "rm -rf /" }, options);

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") expect(result.message).toContain("--once mode");
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it("denies an AskUserQuestion immediately with blocked-status guidance", async () => {
    const { canUseTool, approvals } = makeCtx({ once: true });

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
    const { canUseTool, approvals } = makeCtx({ once: false });
    vi.mocked(approvals.request).mockResolvedValue({ allowed: true });

    const result = await canUseTool("Bash", { command: "ls" }, options);

    expect(approvals.request).toHaveBeenCalledOnce();
    expect(result.behavior).toBe("allow");
  });
});
