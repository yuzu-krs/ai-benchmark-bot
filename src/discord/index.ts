import type { BotStore } from "../application/ports.js";
import { requireDiscordConfig, type AppConfig } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import { BenchmarkBotController, createDiscordClient } from "./bot.js";
import { putBenchmarkGuildCommand } from "./commands.js";
import {
  pumpDeliveryQueue,
  RestDiscordMessageSender
} from "./delivery-worker.js";

export * from "./bot.js";
export * from "./commands.js";
export * from "./delivery-worker.js";
export * from "./embeds.js";

export async function registerGuildCommands(config: AppConfig, logger?: Logger): Promise<void> {
  const discord = requireDiscordConfig(config);
  await putBenchmarkGuildCommand({
    clientId: discord.discordClientId,
    guildId: discord.discordGuildId,
    token: discord.discordToken
  });
  logger?.info("Discord guild command registered", { guildId: discord.discordGuildId });
}

export interface DiscordRuntime {
  start(): Promise<void>;
  stop(): void;
  pumpDeliveries(): Promise<void>;
}

export interface DiscordRuntimeOptions {
  config: AppConfig;
  store: BotStore;
  logger?: Logger;
}

export function createDiscordRuntime(options: DiscordRuntimeOptions): DiscordRuntime {
  const discord = requireDiscordConfig(options.config);
  const client = createDiscordClient();
  const controller = new BenchmarkBotController({
    client,
    store: options.store,
    token: discord.discordToken,
    timeZone: options.config.timeZone,
    inactiveTargets: [
      ...(options.config.enableMeta ? [] : ["provider-meta"]),
      ...(options.config.enableQwen ? [] : ["provider-qwen"])
    ],
    ...(options.logger ? { logger: options.logger } : {})
  });
  const sender = new RestDiscordMessageSender(client.rest);

  return {
    start: () => controller.start(),
    stop: () => controller.stop(),
    pumpDeliveries: async () => {
      await pumpDeliveryQueue({
        store: options.store,
        sender,
        ...(options.logger ? { logger: options.logger } : {})
      });
    }
  };
}
