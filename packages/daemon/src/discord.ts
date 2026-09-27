import type { DiscordBotHandle, StartDiscordBotOptions } from "@fleet/discord";
import type { FleetConfig } from "@fleet/shared";
import type { FleetEvents } from "./events.ts";
import { log, logError } from "./log.ts";
import type { ApprovalManager } from "./session/approvals.ts";

export interface DiscordBotDeps {
  config: FleetConfig;
  approvals: ApprovalManager;
  events: FleetEvents;
  dryRun: boolean;
  once: boolean;
  describeTicket: (project: string, issueNumber: number) => { title?: string; url?: string } | undefined;
  env?: NodeJS.ProcessEnv;
  /** Loads `@fleet/discord` — injectable so tests can prove it isn't loaded when the bot is off. */
  load?: () => Promise<{ startDiscordBot(opts: StartDiscordBotOptions): Promise<DiscordBotHandle> }>;
}

/**
 * Starts the Discord approvals bot when `config.discord` is set — never under
 * `--dry-run` or `--once` (there's nothing to answer in either). `@fleet/discord`,
 * and with it `discord.js`, is loaded by dynamic import only on that path, so
 * installs without the block never load it. Any failure is logged and
 * swallowed: the bot is a convenience, and the daemon runs fine without it.
 */
export async function maybeStartDiscordBot(deps: DiscordBotDeps): Promise<DiscordBotHandle | undefined> {
  const discord = deps.config.discord;
  if (!discord || deps.dryRun || deps.once) return undefined;
  const token = discord.botToken ?? (deps.env ?? process.env).FLEET_DISCORD_BOT_TOKEN;
  if (!token) {
    log("discord", "discord is configured but has no bot token (set discord.botToken or FLEET_DISCORD_BOT_TOKEN) — not starting the approvals bot");
    return undefined;
  }
  const projectChannels = Object.fromEntries(deps.config.projects.flatMap((p) => (p.discord ? [[p.name, p.discord.channelId]] : [])));
  try {
    const { startDiscordBot } = await (deps.load ?? (() => import("@fleet/discord")))();
    return await startDiscordBot({
      token,
      settings: {
        channelId: discord.channelId,
        projectChannels,
        allowedUserIds: discord.allowedUserIds,
        approvalTimeoutMs: deps.config.approvalTimeoutMinutes * 60_000,
      },
      operator: {
        resolveApproval: (id, outcome) => deps.approvals.resolve(id, outcome),
        listApprovals: () => deps.approvals.list(),
        describeTicket: deps.describeTicket,
      },
      events: deps.events,
      logger: { log: (message) => log("discord", message), error: (message, err) => logError("discord", message, err) },
    });
  } catch (err) {
    logError("discord", "could not start the approvals bot — continuing without it", err);
    return undefined;
  }
}
