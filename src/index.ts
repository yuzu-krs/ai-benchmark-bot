import { AppScheduler } from "./application/scheduler.js";
import { loadConfig, requireDiscordConfig } from "./core/config.js";
import { createLogger, errorFields } from "./core/logger.js";
import { requireSupportedNodeVersion } from "./core/runtime.js";
import { localDateKey } from "./core/time.js";
import { createStore } from "./db/index.js";
import { createDiscordRuntime } from "./discord/index.js";
import { createSourceAdapters } from "./sources/index.js";
import {
  REQUIRED_STAGED_CONTRACT_DAYS,
  STAGED_CONTRACT_VERSION
} from "./sources/staged.js";

async function main(): Promise<void> {
  requireSupportedNodeVersion();
  const config = loadConfig();
  const discordConfig = requireDiscordConfig(config);
  const logger = createLogger(config.logLevel);
  const store = createStore(config.databasePath);
  const contractDate = localDateKey(new Date(), config.timeZone);
  const metaStreak = store.getAdapterContractStreak(
    "meta",
    contractDate,
    STAGED_CONTRACT_VERSION
  );
  const qwenStreak = store.getAdapterContractStreak(
    "qwen",
    contractDate,
    STAGED_CONTRACT_VERSION
  );
  const enableMeta = config.enableMeta && metaStreak >= REQUIRED_STAGED_CONTRACT_DAYS;
  const enableQwen = config.enableQwen && qwenStreak >= REQUIRED_STAGED_CONTRACT_DAYS;
  if (config.enableMeta && !enableMeta) {
    logger.warn("Meta adapter remains disabled until its contract gate passes", {
      streak: metaStreak,
      requiredDays: REQUIRED_STAGED_CONTRACT_DAYS
    });
  }
  if (config.enableQwen && !enableQwen) {
    logger.warn("Qwen adapter remains disabled until its contract gate passes", {
      streak: qwenStreak,
      requiredDays: REQUIRED_STAGED_CONTRACT_DAYS
    });
  }
  const runtimeConfig = { ...config, enableMeta, enableQwen };
  const adapters = createSourceAdapters({
    enableMeta,
    enableQwen
  });
  store.syncActiveSources(
    adapters.map((adapter) => adapter.id),
    new Date().toISOString()
  );
  const discord = createDiscordRuntime({ config: runtimeConfig, store, logger });
  const scheduler = new AppScheduler({
    adapters,
    config: runtimeConfig,
    store,
    guildId: discordConfig.discordGuildId,
    logger,
    pumpDeliveries: () => discord.pumpDeliveries()
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown requested", { signal });
    await scheduler.stopAndWait();
    await discord.stop();
    store.close();
    logger.info("shutdown completed");
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await discord.start();
  scheduler.start();
  logger.info("AI benchmark bot started", {
    guildId: discordConfig.discordGuildId,
    sourceCount: adapters.length,
    databasePath: config.databasePath
  });
}

main().catch((error) => {
  const logger = createLogger("error");
  logger.error("fatal startup error", errorFields(error));
  process.exitCode = 1;
});
