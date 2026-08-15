import { EventEmitter } from "node:events";
import type { PendingApproval } from "@fleet/shared";
import { log } from "../log.ts";

export interface ApprovalOutcome {
  allowed: boolean;
  message?: string;
}

interface PendingInternal {
  approval: PendingApproval;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ApprovalManager {
  readonly events = new EventEmitter();
  private readonly pending = new Map<string, PendingInternal>();
  private counter = 0;

  request(opts: {
    project: string;
    issueNumber: number;
    toolName: string;
    kind: PendingApproval["kind"];
    input: unknown;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<ApprovalOutcome> {
    const id = `apr-${++this.counter}-${opts.issueNumber}`;
    const approval: PendingApproval = {
      id,
      project: opts.project,
      issueNumber: opts.issueNumber,
      toolName: opts.toolName,
      kind: opts.kind,
      input: opts.input,
      createdAt: new Date().toISOString(),
    };
    log("approvals", `${opts.project}#${opts.issueNumber}: ${opts.toolName} awaiting ${opts.kind === "question" ? "answers" : "approval"} (${id})`);
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(id, { allowed: false }, "timed out"), opts.timeoutMs);
      const entry: PendingInternal = { approval, resolve, timer, signal: opts.signal };
      if (opts.signal) {
        entry.onAbort = () => this.settle(id, { allowed: false }, "session aborted");
        opts.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      this.events.emit("approvals");
    });
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  resolve(id: string, outcome: ApprovalOutcome): boolean {
    const reason = outcome.message ? "answered" : outcome.allowed ? "allowed" : "denied";
    return this.settle(id, outcome, reason);
  }

  private settle(id: string, outcome: ApprovalOutcome, reason: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.onAbort) entry.signal?.removeEventListener("abort", entry.onAbort);
    log("approvals", `${entry.approval.project}#${entry.approval.issueNumber}: ${entry.approval.toolName} ${reason} (${id})`);
    entry.resolve(outcome);
    this.events.emit("approvals");
    return true;
  }
}
