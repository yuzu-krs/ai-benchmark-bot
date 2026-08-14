import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional()
);

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

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
  DISCORD_CLIENT_ID: optionalSecret,
  DISCORD_GUILD_ID: optionalSecret,
  DATABASE_PATH: z.string().min(1).default("./data/bot.sqlite"),
  BACKUP_DIR: z.string().min(1).default("./backups"),
  TIME_ZONE: z
    .string()
    .min(1)
    .refine(isIanaTimeZone, "TIME_ZONE must be a valid IANA time zone")
    .default("Asia/Tokyo"),
  DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(7),
  DIGEST_MINUTE: z.coerce.number().int().min(0).max(59).default(0),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  GITHUB_TOKEN: optionalSecret,
  HUGGINGFACE_TOKEN: optionalSecret,
  ENABLE_META: booleanFromEnv.default(false),
  ENABLE_QWEN: booleanFromEnv.default(false),
  ENABLE_ZAI: booleanFromEnv.default(false),
  ENABLE_MOONSHOT: booleanFromEnv.default(false)
});

export interface AppConfig {
  discordToken?: string;
  discordClientId?: string;
  discordGuildId?: string;
  databasePath: string;
  backupDir: string;
  timeZone: string;
  digestHour: number;
  digestMinute: number;
  logLevel: "debug" | "info" | "warn" | "error";
  githubToken?: string;
  huggingFaceToken?: string;
  enableMeta: boolean;
  enableQwen: boolean;
  enableZai: boolean;
  enableMoonshot: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(env);
  const config: AppConfig = {
    databasePath: resolve(parsed.DATABASE_PATH),
    backupDir: resolve(parsed.BACKUP_DIR),
    timeZone: parsed.TIME_ZONE,
    digestHour: parsed.DIGEST_HOUR,
    digestMinute: parsed.DIGEST_MINUTE,
    logLevel: parsed.LOG_LEVEL,
    enableMeta: parsed.ENABLE_META,
    enableQwen: parsed.ENABLE_QWEN,
    enableZai: parsed.ENABLE_ZAI,
    enableMoonshot: parsed.ENABLE_MOONSHOT
  };

  if (parsed.DISCORD_TOKEN) config.discordToken = parsed.DISCORD_TOKEN;
  if (parsed.DISCORD_CLIENT_ID) config.discordClientId = parsed.DISCORD_CLIENT_ID;
  if (parsed.DISCORD_GUILD_ID) config.discordGuildId = parsed.DISCORD_GUILD_ID;
  if (parsed.GITHUB_TOKEN) config.githubToken = parsed.GITHUB_TOKEN;
  if (parsed.HUGGINGFACE_TOKEN) config.huggingFaceToken = parsed.HUGGINGFACE_TOKEN;
  return config;
}

export function requireDiscordConfig(config: AppConfig): Required<
  Pick<AppConfig, "discordToken" | "discordClientId" | "discordGuildId">
> {
  if (!config.discordToken || !config.discordClientId || !config.discordGuildId) {
    throw new Error(
      "DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID are required for the bot and command registration"
    );
  }
  return {
    discordToken: config.discordToken,
    discordClientId: config.discordClientId,
    discordGuildId: config.discordGuildId
  };
}
