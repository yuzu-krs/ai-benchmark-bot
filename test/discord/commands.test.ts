import { GatewayIntentBits } from "discord.js";
import { describe, expect, it } from "vitest";
import { createDiscordClient, requiresManageGuild } from "../../src/discord/bot.js";
import { benchmarkCommandJson } from "../../src/discord/commands.js";

describe("benchmark slash command", () => {
  it("publishes all command groups and read commands as a guild command", () => {
    expect(benchmarkCommandJson.name).toBe("benchmark");
    expect(benchmarkCommandJson.contexts).toEqual([0]);
    const optionNames = benchmarkCommandJson.options?.map((option) => option.name);
    expect(optionNames).toEqual(
      expect.arrayContaining(["setup", "watch", "ranking", "changes", "digest", "status", "test"])
    );
  });

  it("uses Guilds only and never requests privileged gateway intents", () => {
    const client = createDiscordClient();
    expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(false);
    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(false);
    expect(client.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(false);
    client.destroy();
  });

  it("requires Manage Guild for writes and channel notifications", () => {
    expect(requiresManageGuild("setup", "channel")).toBe(true);
    expect(requiresManageGuild("watch", "enable")).toBe(true);
    expect(requiresManageGuild("watch", "disable")).toBe(true);
    expect(requiresManageGuild(null, "test")).toBe(true);
    expect(requiresManageGuild("digest", "now")).toBe(true);
    expect(requiresManageGuild("watch", "list")).toBe(false);
    expect(requiresManageGuild(null, "ranking")).toBe(false);
  });
});
