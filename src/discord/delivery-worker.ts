import type { APIEmbed, REST } from "discord.js";
import { Routes } from "discord.js";
import type { BotStore, Delivery } from "../application/ports.js";
import { sha256 } from "../core/hash.js";
import type { Logger } from "../core/logger.js";
import { embedsForDelivery } from "./embeds.js";

export interface DiscordMessagePayload {
  embeds: APIEmbed[];
  allowed_mentions: { parse: [] };
  nonce: string;
  enforce_nonce: true;
}

export interface DiscordMessageSender {
  send(channelId: string, payload: DiscordMessagePayload): Promise<{ id: string }>;
}

export class RestDiscordMessageSender implements DiscordMessageSender {
  public constructor(private readonly rest: REST) {}

  public async send(channelId: string, payload: DiscordMessagePayload): Promise<{ id: string }> {
    const response = await this.rest.post(Routes.channelMessages(channelId), { body: payload });
    if (!response || typeof response !== "object" || !("id" in response)) {
      throw new Error("Discord returned a message response without an id");
    }
    const id = (response as { id?: unknown }).id;
    if (typeof id !== "string") throw new Error("Discord returned an invalid message id");
    return { id };
  }
}

export function deliveryNonce(deliveryId: string): string {
  return sha256(`ai-benchmark-bot:${deliveryId}`).slice(0, 24);
}

export function messageForDelivery(delivery: Delivery): DiscordMessagePayload {
  return {
    embeds: embedsForDelivery(delivery),
    allowed_mentions: { parse: [] },
    nonce: deliveryNonce(delivery.id),
    enforce_nonce: true
  };
}

interface ErrorRecord {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  retryAfter?: unknown;
  retry_after?: unknown;
  rawError?: unknown;
  headers?: unknown;
  message?: unknown;
}

function errorRecord(error: unknown): ErrorRecord {
  return error && typeof error === "object" ? (error as ErrorRecord) : {};
}

export function discordErrorStatus(error: unknown): number | undefined {
  const record = errorRecord(error);
  for (const value of [record.status, record.statusCode]) {
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed === "number" && Number.isInteger(parsed)) return parsed;
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function retryAfterFromHeaders(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if ("get" in headers && typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): unknown }).get("retry-after");
    const seconds = positiveNumber(value);
    return seconds === undefined ? undefined : seconds * 1_000;
  }
  const headerRecord = headers as Record<string, unknown>;
  const seconds = positiveNumber(headerRecord["retry-after"] ?? headerRecord["Retry-After"]);
  return seconds === undefined ? undefined : seconds * 1_000;
}

export function retryDelayMilliseconds(error: unknown, attempts: number): number {
  const record = errorRecord(error);
  const raw = errorRecord(record.rawError);
  const apiSeconds = positiveNumber(record.retry_after) ?? positiveNumber(raw.retry_after);
  if (apiSeconds !== undefined) return Math.ceil(apiSeconds * 1_000);

  const libraryRetry = positiveNumber(record.retryAfter) ?? positiveNumber(raw.retryAfter);
  if (libraryRetry !== undefined) {
    // discord.js exposes milliseconds; some test doubles and raw clients expose seconds.
    return Math.ceil(libraryRetry < 100 ? libraryRetry * 1_000 : libraryRetry);
  }
  const headerDelay = retryAfterFromHeaders(record.headers);
  if (headerDelay !== undefined) return Math.ceil(headerDelay);

  return Math.min(60 * 60_000, 30_000 * 2 ** Math.min(Math.max(attempts, 0), 7));
}

function deliveryErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : errorRecord(error).message;
  return String(message ?? error).slice(0, 1_000);
}

export interface DeliveryPumpResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  disabledChannels: number;
}

export interface PumpDeliveryOptions {
  store: Pick<
    BotStore,
    | "claimPendingDeliveries"
    | "markDeliverySent"
    | "markDeliveryRetry"
    | "markDeliveryFailed"
    | "disableGuildChannel"
    | "getGuildSettings"
  >;
  sender: DiscordMessageSender;
  logger?: Logger;
  now?: Date;
  limit?: number;
  maxAttempts?: number;
}

export async function pumpDeliveryQueue(options: PumpDeliveryOptions): Promise<DeliveryPumpResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 25;
  const maxAttempts = options.maxAttempts ?? 8;
  const deliveries = options.store.claimPendingDeliveries(now.toISOString(), limit);
  const result: DeliveryPumpResult = {
    claimed: deliveries.length,
    sent: 0,
    retried: 0,
    failed: 0,
    disabledChannels: 0
  };

  // Keep this sequential. discord.js also coordinates route-specific Discord rate limits.
  for (const delivery of deliveries) {
    const settings = options.store.getGuildSettings(delivery.guildId);
    if (!settings?.channelId) {
      options.store.markDeliveryFailed(delivery.id, "notification channel is not configured");
      result.failed += 1;
      continue;
    }
    try {
      const response = await options.sender.send(settings.channelId, messageForDelivery(delivery));
      options.store.markDeliverySent(delivery.id, response.id, now.toISOString());
      result.sent += 1;
    } catch (error) {
      const status = discordErrorStatus(error);
      const message = deliveryErrorMessage(error);
      const permanentClientError = status !== undefined && status >= 400 && status < 500 && status !== 429;

      if (status === 403 || status === 404) {
        options.store.markDeliveryFailed(delivery.id, message);
        options.store.disableGuildChannel(delivery.guildId, settings.channelId);
        result.failed += 1;
        result.disabledChannels += 1;
        options.logger?.warn("Discord notification channel disabled", {
          deliveryId: delivery.id,
          guildId: delivery.guildId,
          channelId: settings.channelId,
          status
        });
      } else if (permanentClientError || (status !== 429 && delivery.attempts >= maxAttempts)) {
        options.store.markDeliveryFailed(delivery.id, message);
        result.failed += 1;
        options.logger?.error("Discord delivery failed permanently", {
          deliveryId: delivery.id,
          status,
          attempts: delivery.attempts
        });
      } else {
        const delay = retryDelayMilliseconds(error, delivery.attempts);
        const nextAttemptAt = new Date(now.getTime() + delay).toISOString();
        options.store.markDeliveryRetry(delivery.id, message, nextAttemptAt);
        result.retried += 1;
        options.logger?.warn("Discord delivery scheduled for retry", {
          deliveryId: delivery.id,
          status,
          attempts: delivery.attempts,
          nextAttemptAt
        });
      }
    }
  }
  return result;
}
