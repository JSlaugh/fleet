import { EventEmitter } from "node:events";
import * as d from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordApprovalAdapter } from "./adapter.ts";
import { chatPortFor, toDiscordModal, toDiscordPayload, wireInteractions, type ClientLike } from "./client.ts";
import type { ButtonResponse } from "./types.ts";

describe("toDiscordPayload / toDiscordModal", () => {
  it("renders an embed plus one button row with the fleet custom ids and styles", () => {
    const payload = toDiscordPayload(
      {
        title: "alpha#7 — Bash",
        description: "Add a thing",
        fields: [{ name: "Input", value: "ls" }],
        color: 0xf59e0b,
        buttons: [
          { customId: "fleet:apr-1-7:approve", label: "Approve", style: "success" },
          { customId: "fleet:apr-1-7:deny", label: "Deny", style: "danger" },
        ],
      },
      d,
    );
    const embed = (payload.embeds![0] as d.EmbedBuilder).toJSON();
    expect(embed.title).toBe("alpha#7 — Bash");
    expect(embed.fields).toEqual([{ name: "Input", value: "ls" }]);
    const row = (payload.components![0] as d.ActionRowBuilder<d.ButtonBuilder>).toJSON();
    expect(row.components.map((c) => [(c as { custom_id: string }).custom_id, c.style])).toEqual([
      ["fleet:apr-1-7:approve", d.ButtonStyle.Success],
      ["fleet:apr-1-7:deny", d.ButtonStyle.Danger],
    ]);
  });

  it("drops the button row entirely for a settled message", () => {
    expect(toDiscordPayload({ title: "t", fields: [], color: 0, buttons: [] }, d).components).toEqual([]);
  });

  it("renders a modal with one optional text input per spec input", () => {
    const modal = toDiscordModal({ customId: "fleet:apr-1-7:answer", title: "Answer alpha#7", inputs: [{ customId: "q0", label: "Q1", placeholder: "Options: yes | no", paragraph: true }] }, d).toJSON();
    expect(modal.custom_id).toBe("fleet:apr-1-7:answer");
    const input = (modal.components[0] as { components: { custom_id: string; required: boolean; placeholder: string }[] }).components[0]!;
    expect(input).toMatchObject({ custom_id: "q0", required: false, placeholder: "Options: yes | no" });
  });
});

/** A fake discord.js interaction: just the members `wireInteractions` touches. */
function interaction(kind: "button" | "modal" | "other", customId: string, values: string[] = []) {
  return {
    customId,
    user: { id: "u-joe", username: "joe" },
    isButton: () => kind === "button",
    isModalSubmit: () => kind === "modal",
    fields: { fields: values.map((value, i) => ({ customId: `q${i}`, value })) },
    reply: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
  };
}

function wired(buttonResponse: ButtonResponse) {
  const client = Object.assign(new EventEmitter(), { channels: { fetch: vi.fn() } });
  const adapter = { handleButton: vi.fn(() => buttonResponse), handleModal: vi.fn(() => ({ kind: "acknowledge" }) as ButtonResponse) } as unknown as DiscordApprovalAdapter;
  wireInteractions(client as unknown as ClientLike, adapter, d, { log: () => {}, error: () => {} });
  const fire = async (i: ReturnType<typeof interaction>) => {
    client.emit("interactionCreate", i);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { adapter, fire };
}

describe("wireInteractions", () => {
  it("acknowledges a settling click with deferUpdate (the settle event does the message edit)", async () => {
    const { adapter, fire } = wired({ kind: "acknowledge" });
    const i = interaction("button", "fleet:apr-1-7:approve");
    await fire(i);
    expect(adapter.handleButton).toHaveBeenCalledWith({ customId: "fleet:apr-1-7:approve", userId: "u-joe", userName: "joe" });
    expect(i.deferUpdate).toHaveBeenCalledOnce();
    expect(i.reply).not.toHaveBeenCalled();
  });

  it("answers a refused click with an ephemeral reply", async () => {
    const { fire } = wired({ kind: "ephemeral", text: "You're not authorized to act on fleet approvals." });
    const i = interaction("button", "fleet:apr-1-7:approve");
    await fire(i);
    expect(i.reply).toHaveBeenCalledWith({ content: "You're not authorized to act on fleet approvals.", flags: d.MessageFlags.Ephemeral });
  });

  it("shows the modal for Answer, then passes submitted field values to the adapter", async () => {
    const { adapter, fire } = wired({ kind: "modal", modal: { customId: "fleet:apr-1-7:answer", title: "Answer", inputs: [{ customId: "q0", label: "Q1", paragraph: true }] } });
    const click = interaction("button", "fleet:apr-1-7:answer");
    await fire(click);
    expect(click.showModal).toHaveBeenCalledOnce();

    const submit = interaction("modal", "fleet:apr-1-7:answer", ["postgres", ""]);
    await fire(submit);
    expect(adapter.handleModal).toHaveBeenCalledWith({ customId: "fleet:apr-1-7:answer", userId: "u-joe", userName: "joe", values: ["postgres", ""] });
    expect(submit.deferUpdate).toHaveBeenCalledOnce();
  });

  it("ignores interactions that aren't fleet's", async () => {
    const { adapter, fire } = wired({ kind: "acknowledge" });
    await fire(interaction("button", "someone-else:thing"));
    await fire(interaction("other", "fleet:apr-1-7:approve"));
    expect(adapter.handleButton).not.toHaveBeenCalled();
  });
});

describe("chatPortFor", () => {
  it("refuses a channel the bot can't post in", async () => {
    const client = { on: () => client, channels: { fetch: vi.fn(async () => ({ isSendable: () => false })) } };
    await expect(chatPortFor(client as unknown as ClientLike, d).send("c1", { title: "t", fields: [], color: 0, buttons: [] })).rejects.toThrow(/not a text channel/);
  });

  it("sends the rendered payload and returns the new message id", async () => {
    const send = vi.fn(async () => ({ id: "m-42" }));
    const client = { on: () => client, channels: { fetch: vi.fn(async () => ({ isSendable: () => true, send })) } };
    await expect(chatPortFor(client as unknown as ClientLike, d).send("c1", { title: "t", fields: [], color: 0, buttons: [] })).resolves.toBe("m-42");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array), components: [] }));
  });
});
