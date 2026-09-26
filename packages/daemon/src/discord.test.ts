import type { StartDiscordBotOptions } from "@fleet/discord";
import { describe, expect, it, vi } from "vitest";
import { maybeStartDiscordBot, type DiscordBotDeps } from "./discord.ts";
import { FleetEvents } from "./events.ts";
import { ApprovalManager } from "./session/approvals.ts";
import { makeFleetConfig, makeProject } from "./test-support.ts";

function deps(patch: Partial<DiscordBotDeps> = {}) {
  const startDiscordBot = vi.fn(async (_opts: StartDiscordBotOptions) => ({ stop: async () => {} }));
  const load = vi.fn(async () => ({ startDiscordBot }));
  const events = new FleetEvents();
  const base: DiscordBotDeps = {
    config: makeFleetConfig({
      discord: { channelId: "chan-1", allowedUserIds: ["u-1"], botToken: "tok" },
      projects: [makeProject(), makeProject({ name: "beta", discord: { channelId: "chan-beta" } })],
    }),
    approvals: new ApprovalManager(events),
    events,
    dryRun: false,
    once: false,
    describeTicket: () => undefined,
    env: {},
    load,
    ...patch,
  };
  return { base, load, startDiscordBot };
}

describe("maybeStartDiscordBot", () => {
  it("never loads @fleet/discord (so never discord.js) when the discord block is unset", async () => {
    const { base, load } = deps();
    expect(await maybeStartDiscordBot({ ...base, config: makeFleetConfig() })).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it("never starts under --dry-run or --once", async () => {
    const { base, load } = deps();
    await maybeStartDiscordBot({ ...base, dryRun: true });
    await maybeStartDiscordBot({ ...base, once: true });
    expect(load).not.toHaveBeenCalled();
  });

  it("stays off without a token, and takes FLEET_DISCORD_BOT_TOKEN when the config omits it", async () => {
    const { base, startDiscordBot } = deps();
    const noToken = makeFleetConfig({ discord: { channelId: "chan-1", allowedUserIds: ["u-1"] } });
    expect(await maybeStartDiscordBot({ ...base, config: noToken })).toBeUndefined();
    expect(startDiscordBot).not.toHaveBeenCalled();

    await maybeStartDiscordBot({ ...base, config: noToken, env: { FLEET_DISCORD_BOT_TOKEN: "env-tok" } });
    expect(startDiscordBot).toHaveBeenCalledWith(expect.objectContaining({ token: "env-tok" }));
  });

  it("starts with the channel routing, allowed users and approval timeout, settling through the real ApprovalManager", async () => {
    const { base, startDiscordBot } = deps();
    await maybeStartDiscordBot(base);
    const opts = startDiscordBot.mock.calls[0]![0];
    expect(opts.settings).toEqual({ channelId: "chan-1", projectChannels: { beta: "chan-beta" }, allowedUserIds: ["u-1"], approvalTimeoutMs: 10 * 60_000 });
    expect(opts.events).toBe(base.events);

    const pending = base.approvals.request({ project: "alpha", issueNumber: 7, toolName: "Bash", kind: "permission", input: {}, timeoutMs: 60_000 });
    const [approval] = opts.operator.listApprovals();
    expect(opts.operator.resolveApproval(approval!.id, { allowed: true })).toBe(true);
    await expect(pending).resolves.toMatchObject({ allowed: true, reason: "allowed" });
  });

  it("logs and carries on when the bot can't be loaded", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { base } = deps({ load: async () => Promise.reject(new Error("module missing")) });
    expect(await maybeStartDiscordBot(base)).toBeUndefined();
    expect(errorSpy.mock.calls.some(([line]) => String(line).includes("continuing without it"))).toBe(true);
    errorSpy.mockRestore();
  });
});
