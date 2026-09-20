import { describe, expect, it, vi } from "vitest";
import { makeCtx as makeLoopCtx, makeProject, makeRecord } from "../test-support.ts";
import { Journal, readJournalTail } from "../store/journal.ts";
import { makeCanUseTool } from "./runner.ts";

const project = makeProject({ machineReview: true, model: "claude-sonnet-5" });

function makeCtx(opts: { once?: boolean } = {}) {
  const ctx = makeLoopCtx({ once: opts.once ?? false });
  const journal = new Journal(ctx.dataDirPath, project.name, 7);
  return { approvals: ctx.approvals, journal, dataDirPath: ctx.dataDirPath, canUseTool: makeCanUseTool(ctx, project, 7, journal) };
}

const options = { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "req-1" };

describe("makeCanUseTool in --once mode", () => {
  it("denies a permission request immediately instead of asking ApprovalManager", async () => {
    const { canUseTool, approvals } = makeCtx({ once: true });

    const result = await canUseTool("Bash", { command: "rm -rf /" }, options);

    expect(result).not.toBeNull();
    expect(result?.behavior).toBe("deny");
    if (result?.behavior === "deny") expect(result.message).toContain("--once mode");
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it("journals the auto-denial as a fleet event", async () => {
    const { canUseTool, dataDirPath } = makeCtx({ once: true });

    await canUseTool("Bash", { command: "rm -rf /" }, options);

    const [entry] = readJournalTail(dataDirPath, project.name, 7, 10);
    expect(entry).toMatchObject({ type: "fleet", event: "approval-decided", toolName: "Bash", outcome: "auto-denied" });
  });

  it("denies an AskUserQuestion immediately with blocked-status guidance", async () => {
    const { canUseTool, approvals } = makeCtx({ once: true });

    const result = await canUseTool("AskUserQuestion", { questions: [] }, options);

    expect(result).not.toBeNull();
    expect(result?.behavior).toBe("deny");
    if (result?.behavior === "deny") {
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
    expect(result?.behavior).toBe("allow");
  });

  it("journals the decided outcome with a wait duration", async () => {
    const { canUseTool, approvals, dataDirPath } = makeCtx({ once: false });
    vi.mocked(approvals.request).mockResolvedValue({ allowed: true, reason: "allowed" });

    await canUseTool("Bash", { command: "ls" }, options);

    const [entry] = readJournalTail(dataDirPath, project.name, 7, 10);
    expect(entry).toMatchObject({ type: "fleet", event: "approval-decided", toolName: "Bash", outcome: "allowed" });
    expect(typeof entry?.waitMs).toBe("number");
  });

  it("bumps lastActivityNote to say it's awaiting approval, then clears it once the approval settles", async () => {
    const ctx = makeLoopCtx({ once: false });
    ctx.state.upsert(makeRecord({ issueNumber: 7, status: "running", lastActivityAt: new Date(Date.now() - 60_000).toISOString() }));
    const journal = new Journal(ctx.dataDirPath, project.name, 7);
    const canUseTool = makeCanUseTool(ctx, project, 7, journal);
    let resolveApproval!: (outcome: { allowed: boolean }) => void;
    vi.mocked(ctx.approvals.request).mockReturnValue(new Promise((resolve) => (resolveApproval = resolve)));

    const pending = canUseTool("Bash", { command: "ls" }, options);
    await Promise.resolve(); // let the pre-request state update run
    expect(ctx.state.get(project.name, 7)?.lastActivityNote).toBe("awaiting approval: Bash");

    resolveApproval({ allowed: true });
    await pending;
    expect(ctx.state.get(project.name, 7)?.lastActivityNote).toBeUndefined();
  });

  it("pauses the session's turn clock for the approval wait and resumes it once settled, on every outcome", async () => {
    const ctx = makeLoopCtx({ once: false });
    const { approvals } = ctx;
    const journal = new Journal(ctx.dataDirPath, project.name, 7);
    const turnClock = { pauseTurnClock: vi.fn(), resumeTurnClock: vi.fn() };
    const canUseTool = makeCanUseTool(ctx, project, 7, journal, () => turnClock);

    vi.mocked(approvals.request).mockResolvedValueOnce({ allowed: true });
    await canUseTool("Bash", { command: "ls" }, options);
    expect(turnClock.pauseTurnClock).toHaveBeenCalledOnce();
    expect(turnClock.resumeTurnClock).toHaveBeenCalledOnce();

    vi.mocked(approvals.request).mockResolvedValueOnce({ allowed: false, reason: "timed out" });
    await canUseTool("Bash", { command: "ls" }, options);
    expect(turnClock.pauseTurnClock).toHaveBeenCalledTimes(2);
    expect(turnClock.resumeTurnClock).toHaveBeenCalledTimes(2);

    vi.mocked(approvals.request).mockResolvedValueOnce({ allowed: false, reason: "session aborted" });
    await canUseTool("Bash", { command: "ls" }, options);
    expect(turnClock.pauseTurnClock).toHaveBeenCalledTimes(3);
    expect(turnClock.resumeTurnClock).toHaveBeenCalledTimes(3);
  });
});
