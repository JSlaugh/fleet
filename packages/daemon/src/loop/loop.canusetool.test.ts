import { describe, expect, it, vi } from "vitest";
import { makeCtx as makeLoopCtx, makeProject } from "../test-support.ts";
import { makeCanUseTool } from "./runner.ts";

const project = makeProject({ machineReview: true, model: "claude-sonnet-5" });

function makeCtx(opts: { once?: boolean } = {}) {
  const ctx = makeLoopCtx({ once: opts.once ?? false });
  return { approvals: ctx.approvals, canUseTool: makeCanUseTool(ctx, project, 7) };
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
