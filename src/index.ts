import { loadConfig, requireRuntimeConfig } from "./config.js";
import { DiscordNotifier } from "./discord.js";
import { createLogger } from "./logger.js";
import { Scheduler } from "./scheduler.js";
import { StateStore } from "./state.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const runtime = requireRuntimeConfig(config);
  const store = new StateStore(config.dataDir);
  const notifier = new DiscordNotifier(runtime.discordToken);
  const send = (embed: Parameters<DiscordNotifier["sendEmbed"]>[1]) =>
    notifier.sendEmbed(runtime.discordChannelId, embed);

  const scheduler = new Scheduler({ config, store, logger, send });
  scheduler.start();
  logger.info("AI benchmark bot started", {
    channel: runtime.discordChannelId,
    dataDir: config.dataDir,
    timeZone: config.timeZone,
    digestAt: `${String(config.digestHour).padStart(2, "0")}:${String(config.digestMinute).padStart(2, "0")}`,
    alertPollMinutes: config.alertPollMinutes
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    void scheduler.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "bot failed to start",
      errorMessage: error instanceof Error ? error.message : String(error)
    })
  );
  process.exit(1);
});
