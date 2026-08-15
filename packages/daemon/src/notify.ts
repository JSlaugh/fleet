import type { FleetConfig, NotificationEvent, ProjectConfig } from "@fleet/shared";
import { logError } from "./log.ts";

export interface NotifyDetail {
  issueNumber: number;
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

/** The `github.com/owner/repo/issues/N` link for an issue-scoped event that has no PR of its own. */
export function issueUrl(project: { githubRepo: string }, issueNumber: number): string {
  return `https://github.com/${project.githubRepo}/issues/${issueNumber}`;
}

/** Whether `event` should be posted under `config` — unset `events` (or no config at all) means every event fires, resp. none does. */
export function shouldNotify(config: FleetConfig["notifications"], event: NotificationEvent): boolean {
  if (!config) return false;
  return !config.events || config.events.includes(event);
}

/** The compact Discord message body for one event — pure so it's cheaply testable without a network mock. */
export function buildNotificationMessage(event: NotificationEvent, project: { name: string }, detail: NotifyDetail): string {
  return [`**${EVENT_TITLES[event]}** — ${project.name}#${detail.issueNumber} ${detail.title}`, detail.detail, detail.url]
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/**
 * Fire-and-forget Discord webhook post. A missing/filtered config, `--dry-run`,
 * or `--once` are all silent no-ops; a request failure (bad URL, non-2xx,
 * network error) is logged once and never propagates — a notification is a
 * convenience layered on top of a ticket path that has already done its real
 * work, so it must never be able to affect that path.
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
  try {
    const res = await fetch(config!.discordUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: buildNotificationMessage(event, project, detail) }),
    });
    if (!res.ok) {
      logError("notify", `discord webhook returned ${res.status} for ${event} on ${project.name}#${detail.issueNumber}`);
    }
  } catch (err) {
    logError("notify", `discord webhook failed for ${event} on ${project.name}#${detail.issueNumber}`, err);
  }
}
