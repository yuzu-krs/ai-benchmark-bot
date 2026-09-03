import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional()
);

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const configSchema = z.object({
  DISCORD_TOKEN: optionalSecret,
  DISCORD_CHANNEL_ID: optionalSecret,
  TIME_ZONE: z
    .string()
    .min(1)
    .refine(isIanaTimeZone, "TIME_ZONE must be a valid IANA time zone")
    .default("Asia/Tokyo"),
  DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(7),
  DIGEST_MINUTE: z.coerce.number().int().min(0).max(59).default(0),
  DATA_DIR: z.string().min(1).default("./data"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ALERT_POLL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  HUGGINGFACE_TOKEN: optionalSecret,
  AA_API_KEY: optionalSecret
});

export interface AppConfig {
  discordToken?: string;
  discordChannelId?: string;
  timeZone: string;
  digestHour: number;
  digestMinute: number;
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  alertPollMinutes: number;
  huggingFaceToken?: string;
  /** Artificial Analysis key; without it the ranking posts without AA boards. */
  aaApiKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(env);
  const config: AppConfig = {
    timeZone: parsed.TIME_ZONE,
    digestHour: parsed.DIGEST_HOUR,
    digestMinute: parsed.DIGEST_MINUTE,
    dataDir: resolve(parsed.DATA_DIR),
    logLevel: parsed.LOG_LEVEL,
    alertPollMinutes: parsed.ALERT_POLL_MINUTES
  };
  if (parsed.DISCORD_TOKEN) config.discordToken = parsed.DISCORD_TOKEN;
  if (parsed.DISCORD_CHANNEL_ID) config.discordChannelId = parsed.DISCORD_CHANNEL_ID;
  if (parsed.HUGGINGFACE_TOKEN) config.huggingFaceToken = parsed.HUGGINGFACE_TOKEN;
  if (parsed.AA_API_KEY) config.aaApiKey = parsed.AA_API_KEY;
  return config;
}

export function requireRuntimeConfig(
  config: AppConfig
): Required<Pick<AppConfig, "discordToken" | "discordChannelId">> {
  if (!config.discordToken || !config.discordChannelId) {
    throw new Error("DISCORD_TOKEN and DISCORD_CHANNEL_ID are required for the bot");
  }
  return {
    discordToken: config.discordToken,
    discordChannelId: config.discordChannelId
  };
}
