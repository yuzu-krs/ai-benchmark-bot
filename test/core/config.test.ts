import { describe, expect, it } from "vitest";
import { loadConfig, requireDiscordConfig } from "../../src/core/config.js";

describe("loadConfig", () => {
  it("applies safe defaults and parses staged flags", () => {
    const config = loadConfig({
      DATABASE_PATH: "./tmp/test.sqlite",
      ENABLE_META: "true",
      ENABLE_QWEN: "0"
    });

    expect(config.timeZone).toBe("Asia/Tokyo");
    expect(config.digestHour).toBe(7);
    expect(config.enableMeta).toBe(true);
    expect(config.enableQwen).toBe(false);
    expect(config.databasePath).toMatch(/tmp[\\/]test\.sqlite$/);
  });

  it("requires all Discord identifiers for Discord operations", () => {
    expect(() => requireDiscordConfig(loadConfig({}))).toThrow(/DISCORD_TOKEN/);
    expect(
      requireDiscordConfig(
        loadConfig({
          DISCORD_TOKEN: "token",
          DISCORD_CLIENT_ID: "client",
          DISCORD_GUILD_ID: "guild"
        })
      )
    ).toEqual({ discordToken: "token", discordClientId: "client", discordGuildId: "guild" });
  });

  it("rejects an invalid time zone before the scheduler starts", () => {
    expect(() => loadConfig({ TIME_ZONE: "Asia/Tokyoo" })).toThrow(/TIME_ZONE/);
  });
});
