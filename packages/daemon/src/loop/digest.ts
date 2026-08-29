import type { DigestGateHold, DigestGateType, DigestResponse, DigestStaleRelease, FleetConfig, ProjectDigest, TicketRecord } from "@fleet/shared";
import { issueUrl } from "./board.ts";
import type { LoopContext } from "./context.ts";
import type { DaemonEvent } from "../store/db.ts";
import { log } from "../log.ts";
import { postDigest } from "../notify.ts";

const GATE_EVENT_TYPES: Record<string, DigestGateType> = {
  "gate-hold-budget": "budget",
  "gate-hold-work-hours": "work-hours",
  "gate-hold-plan-limit": "plan-limit",
  "gate-hold-auth-probe": "auth",
};

export interface DigestInput {
  /** Live ticket records — `StateStore.all()`. */
  tickets: TicketRecord[];
  /** Daemon events (auto-merges, stale-claim releases, gate holds) since the window start. */
  events: DaemonEvent[];
  projects: { name: string; githubRepo: string }[];
  windowHours: number;
  now: Date;
  /** The daemon's self-estimated spend actually incurred in `[since, now]` — omitted when the budget feature is off. */
  spentUsd?: number;
  budgetUsd?: number;
  /** The budget gate's own configured window — may differ from `windowHours`. */
  budgetWindowHours?: number;
}

function emptyProjectDigest(project: string): ProjectDigest {
  return { project, completed: [], autoMerged: [], blocked: [], failed: [], staleReleases: [], spendUsd: 0 };
}

/**
 * Pure rollup over already-fetched state: what happened across every project
 * in `[now - windowHours, now]`. Deliberately sourced from live `TicketRecord`
 * status (completed/blocked/failed — "what's true about a ticket right now,
 * touched within the window") plus a small persisted event log (auto-merges,
 * stale-claim releases, gate holds — "things that happened at a point in
 * time", none of which have any other durable trace once their in-memory
 * dedup state clears). A ticket that both completes and gets cleaned up out of
 * live state within the same window is a known gap — it stops appearing under
 * "completed" once cleanup removes its live record — accepted for a first cut
 * since the far more common case (review still pending, or an auto-merge,
 * which is event-sourced) is covered.
 */
export function computeDigest(input: DigestInput): DigestResponse {
  const since = new Date(input.now.getTime() - input.windowHours * 60 * 60 * 1000).toISOString();
  const until = input.now.toISOString();
  const inWindow = (iso: string | undefined): boolean => !!iso && iso >= since && iso <= until;

  const byProject = new Map<string, ProjectDigest>();
  const get = (name: string): ProjectDigest => {
    let digest = byProject.get(name);
    if (!digest) {
      digest = emptyProjectDigest(name);
      byProject.set(name, digest);
    }
    return digest;
  };

  for (const t of input.tickets) {
    if (!inWindow(t.lastActivityAt)) continue;
    const url = issueUrl(input.projects, t);
    if (t.status === "review") {
      const d = get(t.project);
      d.completed.push({ project: t.project, issueNumber: t.issueNumber, title: t.issueTitle, url, prUrl: t.prUrl, costUsd: t.costUsd });
      d.spendUsd += t.costUsd;
    } else if (t.status === "needs-input") {
      const d = get(t.project);
      d.blocked.push({ project: t.project, issueNumber: t.issueNumber, title: t.issueTitle, url, reason: t.lastSummary });
      d.spendUsd += t.costUsd;
    } else if (t.status === "failed") {
      const d = get(t.project);
      d.failed.push({ project: t.project, issueNumber: t.issueNumber, title: t.issueTitle, url, reason: t.lastSummary });
      d.spendUsd += t.costUsd;
    }
  }

  const gateHolds: DigestGateHold[] = [];
  for (const event of input.events) {
    if (!inWindow(event.at)) continue;

    if (event.type === "auto-merged" && event.project && event.issueNumber !== undefined) {
      const d = get(event.project);
      const data = event.data as { title?: string; prUrl?: string; costUsd?: number };
      d.autoMerged.push({
        project: event.project,
        issueNumber: event.issueNumber,
        title: data.title ?? `issue ${event.issueNumber}`,
        url: issueUrl(input.projects, { project: event.project, issueNumber: event.issueNumber }),
        prUrl: data.prUrl,
        costUsd: data.costUsd,
      });
      d.spendUsd += data.costUsd ?? 0;
    } else if (event.type === "stale-claim-released" && event.project && event.issueNumber !== undefined) {
      const d = get(event.project);
      const data = event.data as { title?: string; owners?: string[] };
      const release: DigestStaleRelease = {
        project: event.project,
        issueNumber: event.issueNumber,
        title: data.title ?? `issue ${event.issueNumber}`,
        url: issueUrl(input.projects, { project: event.project, issueNumber: event.issueNumber }),
        owners: data.owners ?? [],
        at: event.at,
      };
      d.staleReleases.push(release);
    } else if (event.type in GATE_EVENT_TYPES) {
      const data = event.data as { detail?: string };
      gateHolds.push({ gate: GATE_EVENT_TYPES[event.type]!, at: event.at, project: event.project, detail: data.detail ?? "" });
    }
  }

  return {
    windowHours: input.windowHours,
    since,
    until,
    projects: [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project)),
    totalSpendUsd: input.spentUsd ?? 0,
    budget: input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd, windowHours: input.budgetWindowHours ?? input.windowHours } : undefined,
    gateHolds,
  };
}

/** `notifications.digestTime`, falling back to `workHoursReserve.workStart` — undefined disables scheduled posting entirely. */
export function resolveDigestTime(config: Pick<FleetConfig, "notifications" | "workHoursReserve">): string | undefined {
  return config.notifications?.digestTime ?? config.workHoursReserve?.workStart;
}

/**
 * Pure restart-safe schedule decision: has today's `digestTime` passed, and
 * has nothing been sent since? `lastSentAt` before today's scheduled instant
 * means today's digest is still owed, whether that's because none has ever
 * been sent or because the last one was yesterday's.
 */
export function shouldSendDigest(now: Date, digestTime: string, lastSentAt: string | undefined): boolean {
  const [hours, minutes] = digestTime.split(":").map(Number);
  const scheduledToday = new Date(now);
  scheduledToday.setHours(hours!, minutes!, 0, 0);
  if (now.getTime() < scheduledToday.getTime()) return false;
  if (!lastSentAt) return true;
  return Date.parse(lastSentAt) < scheduledToday.getTime();
}

const DIGEST_WINDOW_HOURS = 24;

/** Gathers real store data and computes the digest for `hours` back from now. */
export function getDigest(ctx: LoopContext, hours: number): DigestResponse {
  const now = new Date();
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
  return computeDigest({
    tickets: ctx.state.all(),
    events: ctx.state.getEventsSince(since),
    projects: ctx.config.projects,
    windowHours: hours,
    now,
    spentUsd: ctx.state.getSpendSince(since),
    budgetUsd: ctx.config.windowBudgetUsd,
    budgetWindowHours: ctx.config.usageWindowHours,
  });
}

/**
 * Daemon-wide, called once per poll cycle: posts the daily digest to Discord
 * when `digestTime` (or its `workHoursReserve.workStart` fallback) has passed
 * for today and nothing has been sent since. A no-op with no `discordUrl`
 * configured — the dashboard panel (`getDigest` above) works regardless.
 */
export async function checkDigestSchedule(ctx: LoopContext): Promise<void> {
  if (!ctx.config.notifications?.discordUrl) return;
  const digestTime = resolveDigestTime(ctx.config);
  if (!digestTime) return;
  const now = new Date();
  if (!shouldSendDigest(now, digestTime, ctx.state.getLastDigestSentAt())) return;

  if (ctx.dryRun) {
    log("loop", "[dry-run] would send the daily digest");
    return;
  }
  if (ctx.once) return;

  const digest = getDigest(ctx, DIGEST_WINDOW_HOURS);
  await postDigest(ctx, digest);
  ctx.state.setLastDigestSentAt(now.toISOString());
}
