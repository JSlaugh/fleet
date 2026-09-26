import type { PendingApproval } from "@fleet/shared";

/** How an approval settled — mirrors `ApprovalOutcome["reason"]` in the daemon's `session/approvals.ts`. */
export type SettleReason = "allowed" | "denied" | "answered" | "timed out" | "session aborted";

/**
 * Everything the adapter may do to the daemon. Passed in by the daemon so this
 * package never imports daemon code — the boundary is this interface plus the
 * event source below.
 */
export interface OperatorApi {
  /** Settles a pending approval — the same `ApprovalManager.resolve` the dashboard's `POST /api/approvals/:id` uses. False when it's no longer pending. */
  resolveApproval(id: string, outcome: { allowed: boolean; message?: string }): boolean;
  listApprovals(): PendingApproval[];
  /** Ticket title/URL for the message, when the daemon knows them. */
  describeTicket?(project: string, issueNumber: number): { title?: string; url?: string } | undefined;
}

/** The slice of the daemon's `FleetEvents` bus the adapter subscribes to; `FleetEvents` satisfies it structurally. */
export interface ApprovalEventSource {
  on(event: "approval:requested", listener: (payload: { approval: PendingApproval }) => void | Promise<void>): void;
  on(event: "approval:settled", listener: (payload: { approval: PendingApproval; reason: SettleReason }) => void | Promise<void>): void;
}

export interface DiscordSettings {
  /** Default channel for approvals. */
  channelId: string;
  /** Per-project channel overrides, by project name. */
  projectChannels?: Record<string, string>;
  /** Only these Discord user ids may approve, deny or answer. */
  allowedUserIds: readonly string[];
  /** Approvals auto-deny after this long — shown as the message's expiry. */
  approvalTimeoutMs: number;
}

export type ButtonStyleName = "success" | "danger" | "primary";

/** A Discord message as plain data — `client.ts` turns it into discord.js builders. */
export interface OutgoingMessage {
  title: string;
  description?: string;
  url?: string;
  fields: { name: string; value: string }[];
  /** Embed accent colour. */
  color: number;
  footer?: string;
  buttons: { customId: string; label: string; style: ButtonStyleName }[];
}

/** A modal (question form) as plain data. */
export interface ModalSpec {
  customId: string;
  title: string;
  inputs: { customId: string; label: string; placeholder?: string; paragraph: boolean }[];
}

/** Where the adapter posts. Implemented over discord.js in `client.ts`, and by a fake in tests. */
export interface ChatPort {
  /** Posts a message and returns its id. */
  send(channelId: string, message: OutgoingMessage): Promise<string>;
  edit(channelId: string, messageId: string, message: OutgoingMessage): Promise<void>;
}

/** What `client.ts` should do with a button interaction. */
export type ButtonResponse =
  | { kind: "ephemeral"; text: string }
  | { kind: "modal"; modal: ModalSpec }
  /** The click settled the approval; the message edit follows from the settle event. */
  | { kind: "acknowledge" };

export interface Logger {
  log(message: string): void;
  error(message: string, err?: unknown): void;
}
