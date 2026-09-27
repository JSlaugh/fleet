import type { PendingApproval } from "@fleet/shared";
import { answerModal, approvalMessage, collapsedMessage, composeAnswers, parseCustomId, settledMessage, type SettledBy } from "./render.ts";
import type { ApprovalEventSource, ButtonResponse, ChatPort, DiscordSettings, Logger, OperatorApi, OutgoingMessage, SettleReason } from "./types.ts";

/** A ticket posting more than this many approvals inside `RATE_WINDOW_MS` gets the rest collapsed into one summary. */
export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 60_000;

interface Posted {
  channelId: string;
  /** Resolves to the message id once the send completes; undefined if the send failed. */
  messageId: Promise<string | undefined>;
  live: OutgoingMessage;
}

interface Collapsed {
  channelId: string;
  messageId: Promise<string | undefined>;
  startedAt: number;
  ids: Set<string>;
  total: number;
}

/**
 * Mirrors pending approvals into Discord and settles them from button clicks.
 *
 * Every settle — a click here, the dashboard, a timeout, a session abort —
 * arrives as `approval:settled`, and that one handler is what edits the
 * message, so a message can never keep live buttons for a dead approval. A
 * click records who clicked just before resolving, so that edit can name them.
 *
 * State is in-memory only: pending approvals don't survive a daemon restart
 * either, and a click on a message from before one gets "no longer pending".
 */
export class DiscordApprovalAdapter {
  private readonly posted = new Map<string, Posted>();
  private readonly collapsedById = new Map<string, Collapsed>();
  private readonly collapsedByTicket = new Map<string, Collapsed>();
  private readonly recentByTicket = new Map<string, number[]>();
  private readonly actors = new Map<string, SettledBy>();

  constructor(
    private readonly opts: {
      settings: DiscordSettings;
      operator: OperatorApi;
      port: ChatPort;
      logger: Logger;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  subscribe(events: ApprovalEventSource): void {
    events.on("approval:requested", ({ approval }) => this.onRequested(approval));
    events.on("approval:settled", ({ approval, reason }) => this.onSettled(approval, reason));
  }

  channelFor(project: string): string {
    return this.opts.settings.projectChannels?.[project] ?? this.opts.settings.channelId;
  }

  async onRequested(approval: PendingApproval): Promise<void> {
    const ticket = `${approval.project}#${approval.issueNumber}`;
    const channelId = this.channelFor(approval.project);
    const now = this.now();
    const recent = (this.recentByTicket.get(ticket) ?? []).filter((t) => now - t < RATE_WINDOW_MS);

    if (recent.length >= RATE_LIMIT) {
      await this.collapse(ticket, approval, channelId, now);
      return;
    }
    recent.push(now);
    this.recentByTicket.set(ticket, recent);

    const described = this.opts.operator.describeTicket?.(approval.project, approval.issueNumber);
    const live = approvalMessage(approval, {
      approvalTimeoutMs: this.opts.settings.approvalTimeoutMs,
      ticketTitle: described?.title,
      ticketUrl: described?.url,
    });
    const messageId = this.opts.port.send(channelId, live).catch((err) => {
      this.opts.logger.error(`could not post approval ${approval.id} for ${ticket} to channel ${channelId}`, err);
      return undefined;
    });
    this.posted.set(approval.id, { channelId, messageId, live });
    await messageId;
  }

  private async collapse(ticket: string, approval: PendingApproval, channelId: string, now: number): Promise<void> {
    let group = this.collapsedByTicket.get(ticket);
    const fresh = !group || now - group.startedAt >= RATE_WINDOW_MS;
    if (fresh) {
      group = { channelId, messageId: Promise.resolve(undefined), startedAt: now, ids: new Set(), total: 0 };
      this.collapsedByTicket.set(ticket, group);
    }
    group!.ids.add(approval.id);
    group!.total++;
    this.collapsedById.set(approval.id, group!);
    const message = collapsedMessage(approval.project, approval.issueNumber, group!.ids.size, group!.total);
    if (fresh) {
      group!.messageId = this.opts.port.send(channelId, message).catch((err) => {
        this.opts.logger.error(`could not post the collapsed-approvals summary for ${ticket}`, err);
        return undefined;
      });
      await group!.messageId;
    } else {
      await this.editCollapsed(group!, message);
    }
  }

  private async editCollapsed(group: Collapsed, message: OutgoingMessage): Promise<void> {
    const id = await group.messageId;
    if (!id) return;
    await this.opts.port.edit(group.channelId, id, message).catch((err) => this.opts.logger.error("could not update a collapsed-approvals summary", err));
  }

  async onSettled(approval: PendingApproval, reason: SettleReason): Promise<void> {
    const by = this.actors.get(approval.id);
    this.actors.delete(approval.id);

    const group = this.collapsedById.get(approval.id);
    if (group) {
      this.collapsedById.delete(approval.id);
      group.ids.delete(approval.id);
      await this.editCollapsed(group, collapsedMessage(approval.project, approval.issueNumber, group.ids.size, group.total));
      return;
    }

    const posted = this.posted.get(approval.id);
    if (!posted) return;
    this.posted.delete(approval.id);
    const messageId = await posted.messageId;
    if (!messageId) return;
    await this.opts.port
      .edit(posted.channelId, messageId, settledMessage(posted.live, reason, by, this.now()))
      .catch((err) => this.opts.logger.error(`could not mark approval ${approval.id} settled in Discord`, err));
  }

  private isAllowed(userId: string): boolean {
    return this.opts.settings.allowedUserIds.includes(userId);
  }

  private pending(approvalId: string): PendingApproval | undefined {
    return this.opts.operator.listApprovals().find((a) => a.id === approvalId);
  }

  /** A button click. Approve/Deny settle immediately; Answer opens the question modal. */
  handleButton(click: { customId: string; userId: string; userName: string }): ButtonResponse {
    const parsed = parseCustomId(click.customId);
    if (!parsed) return { kind: "ephemeral", text: "Unrecognised fleet button." };
    if (!this.isAllowed(click.userId)) return { kind: "ephemeral", text: "You're not authorized to act on fleet approvals." };
    const approval = this.pending(parsed.approvalId);
    if (!approval) return { kind: "ephemeral", text: "That approval is no longer pending." };
    if (parsed.action === "answer") return { kind: "modal", modal: answerModal(approval) };
    return this.settle(approval.id, { allowed: parsed.action === "approve" }, click.userName);
  }

  /** A submitted question modal. */
  handleModal(submit: { customId: string; userId: string; userName: string; values: readonly string[] }): ButtonResponse {
    const parsed = parseCustomId(submit.customId);
    if (!parsed || parsed.action !== "answer") return { kind: "ephemeral", text: "Unrecognised fleet form." };
    if (!this.isAllowed(submit.userId)) return { kind: "ephemeral", text: "You're not authorized to act on fleet approvals." };
    const approval = this.pending(parsed.approvalId);
    if (!approval) return { kind: "ephemeral", text: "That question is no longer pending." };
    const message = composeAnswers(approval, submit.values);
    if (!message) return { kind: "ephemeral", text: "Please answer at least one question." };
    return this.settle(approval.id, { allowed: false, message }, submit.userName);
  }

  private settle(approvalId: string, outcome: { allowed: boolean; message?: string }, userName: string): ButtonResponse {
    this.actors.set(approvalId, { name: userName });
    if (!this.opts.operator.resolveApproval(approvalId, outcome)) {
      this.actors.delete(approvalId);
      return { kind: "ephemeral", text: "That approval is no longer pending." };
    }
    return { kind: "acknowledge" };
  }
}
