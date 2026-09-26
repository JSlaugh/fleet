import { EventEmitter } from "node:events";
import type { DigestResponse, PendingApproval, ProjectConfig } from "@fleet/shared";
import { logError } from "./log.ts";
import type { ApprovalOutcome } from "./session/approvals.ts";

/** The shape every ticket-lifecycle event shares — identical to `NotifyDetail` plus the project it happened on, so `notify.ts` can subscribe with no message-format change. */
interface TicketEventPayload {
  project: ProjectConfig;
  issueNumber: number;
  title: string;
  detail: string;
  url: string;
}

/** A daemon-wide pause has no single triggering issue when it comes from a project-wide gate (e.g. the budget gate); one that comes from a specific ticket (a usage-limit or auth failure) carries it. */
interface DaemonPausedPayload {
  project: ProjectConfig;
  issueNumber?: number;
  title: string;
  detail: string;
  url: string;
}

/**
 * The daemon's typed event map. The loop emits these and knows nothing about
 * who's listening; each integration (the Discord webhook, the dashboard's WS
 * broadcast, future subscribers) reacts independently. See the "Integration
 * boundary" section of `CLAUDE.md`.
 */
export interface FleetEventMap {
  "ticket:needs-input": TicketEventPayload;
  "ticket:pr-opened": TicketEventPayload;
  "ticket:failed": TicketEventPayload;
  "ticket:auto-merged": TicketEventPayload;
  "ticket:stale-released": TicketEventPayload;
  "daemon:paused": DaemonPausedPayload;
  "approval:requested": { approval: PendingApproval };
  "approval:settled": { approval: PendingApproval; reason: NonNullable<ApprovalOutcome["reason"]> };
  "board:updated": Record<string, never>;
  /** Emitted once a scheduled digest has been computed and cleared to send — `loop/digest.ts` gates on schedule/dry-run/once itself, so a subscriber only needs to deliver it. */
  "digest:ready": { digest: DigestResponse };
}

/**
 * A thin, typed wrapper over `node:events` — the daemon's single event bus.
 * `emit` isolates every subscriber from the caller: a throwing or rejecting
 * listener is logged and swallowed, never propagated, so a broken integration
 * (a bad webhook, a slow WS fan-out) can never affect the ticket path that
 * emitted the event. Callers should treat `emit` as fire-and-forget — it never
 * returns a promise to await. What fire-and-forget costs is paid once, at
 * shutdown: `flush` waits for listeners still in flight (a webhook post), so a
 * drain or stop-now that exits right after the last ticket settles doesn't
 * drop that ticket's notification.
 */
export class FleetEvents {
  private readonly emitter = new EventEmitter();
  private readonly inFlight = new Set<Promise<unknown>>();

  on<K extends keyof FleetEventMap>(event: K, listener: (payload: FleetEventMap[K]) => void | Promise<void>): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof FleetEventMap>(event: K, payload: FleetEventMap[K]): void {
    for (const listener of this.emitter.listeners(event) as ((payload: FleetEventMap[K]) => void | Promise<void>)[]) {
      try {
        const settled = Promise.resolve(listener(payload)).catch((err) => logError("events", `subscriber for "${event}" failed`, err));
        this.inFlight.add(settled);
        void settled.finally(() => this.inFlight.delete(settled));
      } catch (err) {
        logError("events", `subscriber for "${event}" failed`, err);
      }
    }
  }

  /**
   * Resolves once every listener promise started so far has settled, or after
   * `timeoutMs` — whichever comes first. Listeners started while flushing are
   * waited for too, so an event emitted by a listener isn't cut off.
   */
  async flush(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining)));
      await Promise.race([Promise.allSettled([...this.inFlight]), timeout]);
      clearTimeout(timer);
    }
  }
}
