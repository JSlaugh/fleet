import { parseWorkerQuestions, type PendingApproval, type WorkerQuestion } from "@fleet/shared";
import type { ModalSpec, OutgoingMessage, SettleReason } from "./types.ts";

export const INPUT_PREVIEW_CHARS = 200;
/** Discord caps a modal at five components. */
export const MAX_MODAL_INPUTS = 5;
const MODAL_LABEL_CHARS = 45;
const PLACEHOLDER_CHARS = 100;

const AMBER = 0xf59e0b;
const GREEN = 0x16a34a;
const RED = 0xdc2626;
const GREY = 0x6b7280;

export type ButtonAction = "approve" | "deny" | "answer";

/** `fleet:<approvalId>:<action>` — one interaction handler dispatches on it. */
export function customId(approvalId: string, action: ButtonAction): string {
  return `fleet:${approvalId}:${action}`;
}

export function parseCustomId(id: string): { approvalId: string; action: ButtonAction } | undefined {
  const match = /^fleet:([^:]+):(approve|deny|answer)$/.exec(id);
  return match ? { approvalId: match[1]!, action: match[2] as ButtonAction } : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Bash → the command; AskUserQuestion → the first question; anything else → a JSON excerpt. Capped at 200 chars. */
export function inputPreview(approval: Pick<PendingApproval, "toolName" | "input">): string {
  const input = approval.input as Record<string, unknown> | null | undefined;
  if (approval.toolName === "Bash" && typeof input?.command === "string") return truncate(input.command, INPUT_PREVIEW_CHARS);
  if (approval.toolName === "AskUserQuestion") {
    const first = parseWorkerQuestions(approval.input)[0];
    if (first) return truncate(first.question, INPUT_PREVIEW_CHARS);
  }
  let json: string;
  try {
    json = JSON.stringify(approval.input) ?? "";
  } catch {
    json = String(approval.input);
  }
  return truncate(json, INPUT_PREVIEW_CHARS);
}

/** Discord renders `<t:unix:R>` as a live relative time ("in 10 minutes") in each viewer's locale. */
function discordTime(ms: number, style: "R" | "t" = "R"): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** Code-fences text for a field, keeping the fence intact if the text itself contains backticks. */
function fenced(text: string): string {
  return `\`\`\`\n${text.replaceAll("```", "ˋˋˋ")}\n\`\`\``;
}

export interface ApprovalMessageContext {
  approvalTimeoutMs: number;
  ticketTitle?: string;
  ticketUrl?: string;
}

/** The live message for a pending approval, with its buttons. */
export function approvalMessage(approval: PendingApproval, ctx: ApprovalMessageContext): OutgoingMessage {
  const expiresAt = Date.parse(approval.createdAt) + ctx.approvalTimeoutMs;
  const isQuestion = approval.kind === "question";
  const fields = [
    { name: "Kind", value: isQuestion ? "Question for you" : `Tool approval: \`${approval.toolName}\`` },
    { name: isQuestion ? "Question" : "Input", value: fenced(inputPreview(approval)) },
  ];
  const questions = isQuestion ? parseWorkerQuestions(approval.input) : [];
  if (questions.length > 1) fields.push({ name: "Questions", value: `${questions.length} — open **Answer** to reply to all of them` });
  fields.push({ name: "Expires", value: `${discordTime(expiresAt)} (then auto-denied)` });
  return {
    title: truncate(`${approval.project}#${approval.issueNumber} — ${isQuestion ? "question" : approval.toolName}`, 256),
    description: ctx.ticketTitle ? truncate(ctx.ticketTitle, 1000) : undefined,
    url: ctx.ticketUrl,
    fields,
    color: AMBER,
    footer: `fleet approval ${approval.id}`,
    buttons: isQuestion
      ? [{ customId: customId(approval.id, "answer"), label: "Answer", style: "primary" }]
      : [
          { customId: customId(approval.id, "approve"), label: "Approve", style: "success" },
          { customId: customId(approval.id, "deny"), label: "Deny", style: "danger" },
        ],
  };
}

/** Who settled it, when it was settled from Discord; absent for dashboard/timeout/abort settles. */
export interface SettledBy {
  name: string;
}

const SETTLE_TEXT: Record<SettleReason, string> = {
  allowed: "Approved",
  denied: "Denied",
  answered: "Answered",
  "timed out": "Timed out; ticket will finish blocked",
  "session aborted": "Session ended before an answer",
};

/** The same message with its buttons removed and the outcome appended, so Discord never shows live buttons for a dead approval. */
export function settledMessage(live: OutgoingMessage, reason: SettleReason, by: SettledBy | undefined, atMs: number): OutgoingMessage {
  const who = by ? ` by ${by.name}` : reason === "timed out" || reason === "session aborted" ? "" : " via the dashboard";
  return {
    ...live,
    color: reason === "allowed" || reason === "answered" ? GREEN : reason === "denied" ? RED : GREY,
    fields: [...live.fields.filter((f) => f.name !== "Expires"), { name: "Outcome", value: `${SETTLE_TEXT[reason]}${who} at ${discordTime(atMs, "t")}` }],
    buttons: [],
  };
}

/** Summary posted in place of individual messages once a ticket floods approvals (see the adapter's rate guard). */
export function collapsedMessage(project: string, issueNumber: number, pending: number, total: number): OutgoingMessage {
  return {
    title: `${project}#${issueNumber} — ${total} more approval${total === 1 ? "" : "s"}`,
    description:
      pending > 0
        ? `${pending} still pending. This ticket requested more than 5 approvals within a minute, so these are collected here — settle them from the fleet dashboard.`
        : "All of these have been settled.",
    fields: [],
    color: pending > 0 ? AMBER : GREY,
    buttons: [],
  };
}

/** One text input per question (up to Discord's five), or a single free-text field when there are more. */
export function answerModal(approval: PendingApproval): ModalSpec {
  const questions = parseWorkerQuestions(approval.input);
  const title = truncate(`Answer ${approval.project}#${approval.issueNumber}`, MODAL_LABEL_CHARS);
  if (questions.length === 0 || questions.length > MAX_MODAL_INPUTS) {
    return {
      customId: customId(approval.id, "answer"),
      title,
      inputs: [{ customId: "all", label: "Your answers", placeholder: truncate(questions.map((q) => q.question).join(" / ") || "Answer", PLACEHOLDER_CHARS), paragraph: true }],
    };
  }
  return {
    customId: customId(approval.id, "answer"),
    title,
    inputs: questions.map((q, i) => ({
      customId: `q${i}`,
      label: truncate(q.header ?? q.question, MODAL_LABEL_CHARS),
      placeholder: truncate(optionHint(q) ?? q.question, PLACEHOLDER_CHARS),
      paragraph: true,
    })),
  };
}

function optionHint(q: WorkerQuestion): string | undefined {
  return q.options && q.options.length > 0 ? `Options: ${q.options.map((o) => o.label).join(" | ")}` : undefined;
}

/**
 * Formats modal answers exactly like the dashboard's `QuestionCard` does
 * (`Q: …\nA: …` blocks), so a worker sees the same shape whichever surface
 * answered. `undefined` when every answer is blank.
 */
export function composeAnswers(approval: PendingApproval, values: readonly string[]): string | undefined {
  const questions = parseWorkerQuestions(approval.input);
  const trimmed = values.map((v) => v.trim());
  if (trimmed.every((v) => v.length === 0)) return undefined;
  if (questions.length === 0 || questions.length > MAX_MODAL_INPUTS) {
    const asked = questions.map((q) => `Q: ${q.question}`).join("\n");
    return `${asked ? `${asked}\n` : ""}A: ${trimmed[0] ?? ""}`;
  }
  return questions.map((q, i) => `Q: ${q.question}\nA: ${trimmed[i] || "(no answer)"}`).join("\n\n");
}
