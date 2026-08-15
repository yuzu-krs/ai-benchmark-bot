import { describe, expect, it } from "vitest";
import { loadConfig, requireRuntimeConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("provides safe defaults", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      timeZone: "Asia/Tokyo",
      digestHour: 7,
      digestMinute: 0,
      logLevel: "info",
      alertPollMinutes: 60
    });
    expect(config.dataDir).toMatch(/data$/);
    expect(config.discordToken).toBeUndefined();
  });

  it("reads required Discord settings and trims empty secrets", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "secret-token",
      DISCORD_CHANNEL_ID: "123456",
      HUGGINGFACE_TOKEN: "   "
    });
    expect(config.discordToken).toBe("secret-token");
    expect(config.discordChannelId).toBe("123456");
    expect(config.huggingFaceToken).toBeUndefined();
  });

  it("rejects an invalid time zone and out-of-range digest times", () => {
    expect(() => loadConfig({ TIME_ZONE: "Mars/Olympus" })).toThrow(/TIME_ZONE/);
    expect(() => loadConfig({ DIGEST_HOUR: "24" })).toThrow();
    expect(() => loadConfig({ DIGEST_MINUTE: "60" })).toThrow();
    expect(() => loadConfig({ ALERT_POLL_MINUTES: "1" })).toThrow();
  });

  it("requires token and channel at runtime", () => {
    expect(() => requireRuntimeConfig(loadConfig({}))).toThrow(/DISCORD_TOKEN/);
    expect(
      requireRuntimeConfig(
        loadConfig({ DISCORD_TOKEN: "t", DISCORD_CHANNEL_ID: "c" })
      )
    ).toEqual({ discordToken: "t", discordChannelId: "c" });
  });
});
