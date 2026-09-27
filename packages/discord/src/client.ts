import type * as DiscordJs from "discord.js";
import { DiscordApprovalAdapter } from "./adapter.ts";
import type { ApprovalEventSource, ButtonResponse, ChatPort, DiscordSettings, Logger, ModalSpec, OperatorApi, OutgoingMessage } from "./types.ts";

type Discord = typeof DiscordJs;

/** Plain-data message → discord.js payload (an embed plus one button row). Pure given the builders module, so it's testable offline. */
export function toDiscordPayload(message: OutgoingMessage, d: Discord): DiscordJs.MessageEditOptions & DiscordJs.MessageCreateOptions {
  const embed = new d.EmbedBuilder().setTitle(message.title).setColor(message.color);
  if (message.description) embed.setDescription(message.description);
  if (message.url) embed.setURL(message.url);
  if (message.fields.length > 0) embed.addFields(message.fields);
  if (message.footer) embed.setFooter({ text: message.footer });
  const styles = { success: d.ButtonStyle.Success, danger: d.ButtonStyle.Danger, primary: d.ButtonStyle.Primary } as const;
  const components =
    message.buttons.length === 0
      ? []
      : [
          new d.ActionRowBuilder<DiscordJs.ButtonBuilder>().addComponents(
            message.buttons.map((b) => new d.ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(styles[b.style])),
          ),
        ];
  return { embeds: [embed], components };
}

export function toDiscordModal(spec: ModalSpec, d: Discord): DiscordJs.ModalBuilder {
  return new d.ModalBuilder()
    .setCustomId(spec.customId)
    .setTitle(spec.title)
    .addComponents(
      spec.inputs.map((input) => {
        const field = new d.TextInputBuilder()
          .setCustomId(input.customId)
          .setLabel(input.label)
          .setStyle(input.paragraph ? d.TextInputStyle.Paragraph : d.TextInputStyle.Short)
          .setRequired(false);
        if (input.placeholder) field.setPlaceholder(input.placeholder);
        return new d.ActionRowBuilder<DiscordJs.TextInputBuilder>().addComponents(field);
      }),
    );
}

/** The minimal slice of a discord.js `Client` the wiring uses — lets tests drive it with a plain emitter. */
export interface ClientLike {
  on(event: "interactionCreate", listener: (interaction: DiscordJs.Interaction) => void): unknown;
  channels: { fetch(id: string): Promise<unknown> };
}

/** A `ChatPort` over a discord.js client: fetch the channel, send or fetch-and-edit the message. */
export function chatPortFor(client: ClientLike, d: Discord): ChatPort {
  const channel = async (id: string) => {
    const ch = (await client.channels.fetch(id)) as DiscordJs.Channel | null;
    if (!ch || !ch.isSendable()) throw new Error(`channel ${id} is not a text channel the bot can post in`);
    return ch;
  };
  return {
    async send(channelId, message) {
      const sent = await (await channel(channelId)).send(toDiscordPayload(message, d));
      return sent.id;
    },
    async edit(channelId, messageId, message) {
      const ch = await channel(channelId);
      if (!("messages" in ch)) throw new Error(`channel ${channelId} has no message history`);
      const existing = await ch.messages.fetch(messageId);
      await existing.edit(toDiscordPayload(message, d));
    },
  };
}

/** Routes button clicks and modal submits to the adapter, and turns its responses into interaction replies. */
export function wireInteractions(client: ClientLike, adapter: DiscordApprovalAdapter, d: Discord, logger: Logger): void {
  client.on("interactionCreate", (interaction) => {
    void (async () => {
      let response: ButtonResponse;
      if (interaction.isButton()) {
        if (!interaction.customId.startsWith("fleet:")) return;
        response = adapter.handleButton({ customId: interaction.customId, userId: interaction.user.id, userName: interaction.user.username });
        if (response.kind === "modal") {
          await interaction.showModal(toDiscordModal(response.modal, d));
          return;
        }
      } else if (interaction.isModalSubmit()) {
        if (!interaction.customId.startsWith("fleet:")) return;
        const values = interaction.fields.fields.map((f) => ("value" in f && typeof f.value === "string" ? f.value : ""));
        response = adapter.handleModal({ customId: interaction.customId, userId: interaction.user.id, userName: interaction.user.username, values });
      } else {
        return;
      }
      if (response.kind === "ephemeral") {
        await interaction.reply({ content: response.text, flags: d.MessageFlags.Ephemeral });
      } else if (response.kind === "acknowledge") {
        // The settle event edits the message; this just closes the interaction.
        await interaction.deferUpdate();
      }
    })().catch((err) => logger.error("failed to handle a Discord interaction", err));
  });
}

export interface StartDiscordBotOptions {
  token: string;
  settings: DiscordSettings;
  operator: OperatorApi;
  events: ApprovalEventSource;
  logger: Logger;
}

export interface DiscordBotHandle {
  stop(): Promise<void>;
}

/**
 * Starts the gateway bot. Resolves once it's wired — login happens in the
 * background, so a bot that can't connect logs once and the daemon carries on
 * without it (discord.js retries dropped gateway connections itself). Only the
 * `Guilds` intent: button and modal interactions need no privileged intents.
 */
export async function startDiscordBot(opts: StartDiscordBotOptions): Promise<DiscordBotHandle> {
  const d = await import("discord.js");
  const client = new d.Client({ intents: [d.GatewayIntentBits.Guilds] });
  const adapter = new DiscordApprovalAdapter({ settings: opts.settings, operator: opts.operator, port: chatPortFor(client, d), logger: opts.logger });
  adapter.subscribe(opts.events);
  wireInteractions(client, adapter, d, opts.logger);
  client.on("error", (err) => opts.logger.error("Discord client error", err));
  client.once("clientReady", (ready) => opts.logger.log(`Discord bot connected as ${ready.user.tag}`));
  client.login(opts.token).catch((err) => opts.logger.error("Discord bot could not log in — continuing without it", err));
  return { stop: () => client.destroy() };
}
