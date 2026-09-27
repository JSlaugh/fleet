import type { PendingApproval } from "@fleet/shared";
import { describe, expect, it, vi } from "vitest";
import { DiscordApprovalAdapter, RATE_LIMIT, RATE_WINDOW_MS } from "./adapter.ts";
import type { ChatPort, OutgoingMessage, SettleReason } from "./types.ts";

/**
 * A stand-in for the daemon's `ApprovalManager` + event bus: `request` emits
 * `approval:requested`, and every settle path (resolve, timeout) emits
 * `approval:settled` synchronously, the way the real manager does. Handler
 * promises are collected so a test can wait for the Discord side to finish.
 */
function harness(opts: { allowedUserIds?: string[]; projectChannels?: Record<string, string>; now?: () => number } = {}) {
  const listeners: { requested: ((p: { approval: PendingApproval }) => void | Promise<void>)[]; settled: ((p: { approval: PendingApproval; reason: SettleReason }) => void | Promise<void>)[] } = { requested: [], settled: [] };
  const inFlight: Promise<unknown>[] = [];
  const pending = new Map<string, PendingApproval>();
  let counter = 0;

  const sends: { channelId: string; message: OutgoingMessage }[] = [];
  const edits: { channelId: string; messageId: string; message: OutgoingMessage }[] = [];
  let releaseSends: (() => void) | undefined;
  let holdSends = false;
  const port: ChatPort = {
    async send(channelId, message) {
      sends.push({ channelId, message });
      if (holdSends) await new Promise<void>((resolve) => (releaseSends = resolve));
      return `m-${sends.length}`;
    },
    edit: vi.fn(async (channelId: string, messageId: string, message: OutgoingMessage) => {
      edits.push({ channelId, messageId, message });
    }),
  };

  const settle = (id: string, reason: SettleReason) => {
    const approval = pending.get(id);
    if (!approval) return false;
    pending.delete(id);
    for (const l of listeners.settled) inFlight.push(Promise.resolve(l({ approval, reason })));
    return true;
  };
  const operator = {
    resolveApproval: vi.fn((id: string, outcome: { allowed: boolean; message?: string }) => settle(id, outcome.message ? "answered" : outcome.allowed ? "allowed" : "denied")),
    listApprovals: () => [...pending.values()],
    describeTicket: () => ({ title: "Add a thing", url: "https://github.com/acme/alpha/issues/7" }),
  };
  const adapter = new DiscordApprovalAdapter({
    settings: { channelId: "chan-default", projectChannels: opts.projectChannels, allowedUserIds: opts.allowedUserIds ?? ["u-joe"], approvalTimeoutMs: 10 * 60_000 },
    operator,
    port,
    logger: { log: () => {}, error: () => {} },
    now: opts.now,
  });
  adapter.subscribe({
    on: ((event: "approval:requested" | "approval:settled", l: never) => {
      if (event === "approval:requested") listeners.requested.push(l);
      else listeners.settled.push(l);
    }) as never,
  });

  return {
    adapter,
    operator,
    sends,
    edits,
    request(patch: Partial<PendingApproval> = {}) {
      const approval: PendingApproval = { id: `apr-${++counter}-7`, project: "alpha", issueNumber: 7, toolName: "Bash", kind: "permission", input: { command: "ls" }, createdAt: new Date().toISOString(), ...patch };
      pending.set(approval.id, approval);
      for (const l of listeners.requested) inFlight.push(Promise.resolve(l({ approval })));
      return approval;
    },
    timeout: (id: string) => settle(id, "timed out"),
    holdSends: () => (holdSends = true),
    releaseSends: () => releaseSends?.(),
    idle: async () => {
      while (inFlight.length > 0) await Promise.all(inFlight.splice(0));
    },
  };
}

const click = (approvalId: string, action: string, userId = "u-joe") => ({ customId: `fleet:${approvalId}:${action}`, userId, userName: userId === "u-joe" ? "joe" : "mallory" });

describe("DiscordApprovalAdapter", () => {
  it("posts each approval to its channel the moment it's requested", async () => {
    const h = harness({ projectChannels: { beta: "chan-beta" } });
    h.request();
    h.request({ project: "beta" });
    await h.idle();
    expect(h.sends.map((s) => s.channelId)).toEqual(["chan-default", "chan-beta"]);
    expect(h.sends[0]?.message.description).toBe("Add a thing");
    expect(h.sends[0]?.message.buttons.map((b) => b.label)).toEqual(["Approve", "Deny"]);
  });

  it("Approve settles through resolveApproval and edits the message to name the approver", async () => {
    const h = harness();
    const a = h.request();
    await h.idle();

    expect(h.adapter.handleButton(click(a.id, "approve"))).toEqual({ kind: "acknowledge" });
    await h.idle();

    expect(h.operator.resolveApproval).toHaveBeenCalledWith(a.id, { allowed: true });
    const edit = h.edits.at(-1)!;
    expect(edit.messageId).toBe("m-1");
    expect(edit.message.buttons).toEqual([]);
    expect(edit.message.fields.at(-1)?.value).toMatch(/^Approved by joe at/);
  });

  it("Deny settles as denied", async () => {
    const h = harness();
    const a = h.request();
    await h.idle();
    h.adapter.handleButton(click(a.id, "deny"));
    await h.idle();
    expect(h.operator.resolveApproval).toHaveBeenCalledWith(a.id, { allowed: false });
    expect(h.edits.at(-1)?.message.fields.at(-1)?.value).toMatch(/^Denied by joe/);
  });

  it("Answer opens the question modal, and submitting it settles with the composed answers", async () => {
    const h = harness();
    const a = h.request({ toolName: "AskUserQuestion", kind: "question", input: { questions: [{ question: "Which db?" }] } });
    await h.idle();

    const response = h.adapter.handleButton(click(a.id, "answer"));
    expect(response.kind).toBe("modal");
    expect(h.operator.resolveApproval).not.toHaveBeenCalled();

    expect(h.adapter.handleModal({ ...click(a.id, "answer"), values: ["postgres"] })).toEqual({ kind: "acknowledge" });
    await h.idle();
    expect(h.operator.resolveApproval).toHaveBeenCalledWith(a.id, { allowed: false, message: "Q: Which db?\nA: postgres" });
    expect(h.edits.at(-1)?.message.fields.at(-1)?.value).toMatch(/^Answered by joe/);
  });

  it("refuses a click from a user not in allowedUserIds, changing nothing", async () => {
    const h = harness();
    const a = h.request();
    await h.idle();
    expect(h.adapter.handleButton(click(a.id, "approve", "u-mallory"))).toEqual({ kind: "ephemeral", text: expect.stringMatching(/not authorized/) });
    expect(h.adapter.handleModal({ ...click(a.id, "answer", "u-mallory"), values: ["x"] }).kind).toBe("ephemeral");
    expect(h.operator.resolveApproval).not.toHaveBeenCalled();
    expect(h.edits).toEqual([]);
  });

  it("tells a click on an approval that's no longer pending (restart, already settled) so", async () => {
    const h = harness();
    expect(h.adapter.handleButton(click("apr-99-7", "approve"))).toEqual({ kind: "ephemeral", text: expect.stringMatching(/no longer pending/) });
    const a = h.request();
    await h.idle();
    h.timeout(a.id);
    await h.idle();
    expect(h.adapter.handleButton(click(a.id, "approve")).kind).toBe("ephemeral");
  });

  it("marks a timed-out approval in Discord", async () => {
    const h = harness();
    const a = h.request();
    await h.idle();
    h.timeout(a.id);
    await h.idle();
    expect(h.edits.at(-1)?.message.buttons).toEqual([]);
    expect(h.edits.at(-1)?.message.fields.at(-1)?.value).toMatch(/^Timed out; ticket will finish blocked/);
  });

  it("marks an approval settled from the dashboard, attributing it there", async () => {
    const h = harness();
    const a = h.request();
    await h.idle();
    h.operator.resolveApproval(a.id, { allowed: true }); // the dashboard's path: no Discord actor recorded
    await h.idle();
    expect(h.edits.at(-1)?.message.fields.at(-1)?.value).toMatch(/^Approved via the dashboard/);
  });

  it("still edits the message when the approval settles before its send completed", async () => {
    const h = harness();
    h.holdSends();
    const a = h.request();
    h.timeout(a.id);
    h.releaseSends();
    await h.idle();
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]?.messageId).toBe("m-1");
  });

  it(`collapses a ticket's approvals past ${RATE_LIMIT} a minute into one summary, fresh again after the window`, async () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    const approvals = Array.from({ length: RATE_LIMIT + 2 }, () => h.request());
    await h.idle();

    expect(h.sends).toHaveLength(RATE_LIMIT + 1);
    const summary = h.sends.at(-1)!.message;
    expect(summary.title).toBe("alpha#7 — 1 more approval");
    expect(summary.buttons).toEqual([]);
    expect(h.edits.at(-1)?.message.title).toBe("alpha#7 — 2 more approvals");

    h.timeout(approvals.at(-1)!.id); // a collapsed one settles: the summary counts down
    await h.idle();
    expect(h.edits.at(-1)?.message.description).toMatch(/^1 still pending/);

    now += RATE_WINDOW_MS;
    h.request();
    await h.idle();
    expect(h.sends.at(-1)?.message.buttons.map((b) => b.label)).toEqual(["Approve", "Deny"]);
  });
});
