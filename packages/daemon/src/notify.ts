import type { FleetConfig, NotificationEvent, ProjectConfig } from "@fleet/shared";
import { logError } from "./log.ts";

export interface NotifyDetail {
  /** Omitted for a project-wide event with no single triggering issue (e.g. the budget gate holding all claims). */
  issueNumber?: number;
  title: string;
  /** One-line status detail (a blocked question, an error message, a merge summary, ...). */
  detail: string;
  url: string;
}

/** The minimal slice of `LoopContext` notify needs — avoids a dependency on `loop/context.ts` from a root-level module. */
export interface NotifyContext {
  readonly config: Pick<FleetConfig, "notifications">;
  readonly dryRun: boolean;
  readonly once: boolean;
}

const EVENT_TITLES: Record<NotificationEvent, string> = {
  "needs-input": "Needs input",
  "pr-opened": "PR opened",
  failed: "Failed",
  paused: "Paused",
  "auto-merged": "Auto-merged",
  "stale-released": "Stale claim released",
};

/** Hard cap on the webhook request so an unresponsive (not just erroring) Discord host can never stall the awaiting ticket path. */
const WEBHOOK_TIMEOUT_MS = 5_000;

/** The `github.com/owner/repo/issues/N` link for an issue-scoped event that has no PR of its own. */
export function issueUrl(project: { githubRepo: string }, issueNumber: number): string {
  return `https://github.com/${project.githubRepo}/issues/${issueNumber}`;
}

/** The `github.com/owner/repo` link for a project-wide event with no single triggering issue. */
export function projectUrl(project: { githubRepo: string }): string {
  return `https://github.com/${project.githubRepo}`;
}

/** Whether `event` should be posted under `config` — unset `events` (or no config at all) means every event fires, resp. none does. */
export function shouldNotify(config: FleetConfig["notifications"], event: NotificationEvent): boolean {
  if (!config) return false;
  return !config.events || config.events.includes(event);
}

/** `project#issue` for an issue-scoped detail, or just `project` for a project-wide one. */
function scopeLabel(project: { name: string }, detail: NotifyDetail): string {
  return detail.issueNumber === undefined ? project.name : `${project.name}#${detail.issueNumber}`;
}

/** The compact Discord message body for one event — pure so it's cheaply testable without a network mock. */
export function buildNotificationMessage(event: NotificationEvent, project: { name: string }, detail: NotifyDetail): string {
  return [`**${EVENT_TITLES[event]}** — ${scopeLabel(project, detail)} ${detail.title}`, detail.detail, detail.url]
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/**
 * Fire-and-forget Discord webhook post. A missing/filtered config, `--dry-run`,
 * or `--once` are all silent no-ops; a request failure (bad URL, non-2xx,
 * network error, or timeout) is logged once and never propagates — a
 * notification is a convenience layered on top of a ticket path that has
 * already done its real work, so it must never be able to affect that path.
 * Most call sites `await` this inline, so the request itself is bounded by
 * `WEBHOOK_TIMEOUT_MS` — without it, a host that accepts the connection but
 * never responds would hang the awaiting ticket path indefinitely instead of
 * just failing fast like every other error case here.
 */
export async function notify(
  ctx: NotifyContext,
  event: NotificationEvent,
  project: ProjectConfig,
  detail: NotifyDetail,
): Promise<void> {
  if (ctx.dryRun || ctx.once) return;
  const config = ctx.config.notifications;
  if (!shouldNotify(config, event)) return;
  const scope = scopeLabel(project, detail);
  try {
    const res = await fetch(config!.discordUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: buildNotificationMessage(event, project, detail) }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      logError("notify", `discord webhook returned ${res.status} for ${event} on ${scope}`);
    }
  } catch (err) {
    logError("notify", `discord webhook failed for ${event} on ${scope}`, err);
  }
}
