import { describe, expect, it, vi } from "vitest";
import type { Delivery } from "../../src/application/ports.js";
import {
  deliveryNonce,
  messageForDelivery,
  pumpDeliveryQueue,
  retryDelayMilliseconds,
  type DiscordMessageSender,
  type PumpDeliveryOptions
} from "../../src/discord/delivery-worker.js";

function testDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: "delivery-1",
    guildId: "guild-1",
    channelId: "channel-1",
    kind: "test",
    payload: { message: "テストです" },
    attempts: 1,
    nextAttemptAt: "2026-08-14T00:00:00.000Z",
    ...overrides
  };
}

function storeWith(deliveries: Delivery[]) {
  return {
    getGuildSettings: vi.fn((guildId: string) => ({
      guildId,
      channelId: deliveries[0]?.channelId,
      locale: "ja",
      timeZone: "Asia/Tokyo"
    })),
    claimPendingDeliveries: vi.fn(() => deliveries),
    markDeliverySent: vi.fn(),
    markDeliveryRetry: vi.fn(),
    markDeliveryFailed: vi.fn(),
    disableGuildChannel: vi.fn()
  } satisfies PumpDeliveryOptions["store"];
}

describe("Discord delivery worker", () => {
  it("sends without mentions and marks the delivery sent", async () => {
    const delivery = testDelivery();
    const store = storeWith([delivery]);
    const sender: DiscordMessageSender = { send: vi.fn(async () => ({ id: "message-1" })) };
    const result = await pumpDeliveryQueue({
      store,
      sender,
      now: new Date("2026-08-14T00:00:00.000Z")
    });

    expect(result).toMatchObject({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(sender.send).toHaveBeenCalledWith(
      "channel-1",
      expect.objectContaining({
        allowed_mentions: { parse: [] },
        nonce: deliveryNonce(delivery.id),
        enforce_nonce: true
      })
    );
    expect(store.markDeliverySent).toHaveBeenCalledWith(
      "delivery-1",
      "message-1",
      "2026-08-14T00:00:00.000Z"
    );
  });

  it("honors Discord retry_after for a 429 response", async () => {
    const store = storeWith([testDelivery()]);
    const sender: DiscordMessageSender = {
      send: vi.fn(async () => {
        throw { status: 429, rawError: { retry_after: 2 } };
      })
    };
    const result = await pumpDeliveryQueue({
      store,
      sender,
      now: new Date("2026-08-14T00:00:00.000Z")
    });
    expect(result.retried).toBe(1);
    expect(store.markDeliveryRetry).toHaveBeenCalledWith(
      "delivery-1",
      expect.any(String),
      "2026-08-14T00:00:02.000Z"
    );
  });

  it("keeps honoring a 429 Retry-After after the ordinary retry limit", async () => {
    const store = storeWith([testDelivery({ attempts: 99 })]);
    const sender: DiscordMessageSender = {
      send: vi.fn(async () => {
        throw { status: 429, rawError: { retry_after: 3 } };
      })
    };

    const result = await pumpDeliveryQueue({
      store,
      sender,
      maxAttempts: 8,
      now: new Date("2026-08-14T00:00:00.000Z")
    });

    expect(result).toMatchObject({ retried: 1, failed: 0 });
    expect(store.markDeliveryRetry).toHaveBeenCalledWith(
      "delivery-1",
      expect.any(String),
      "2026-08-14T00:00:03.000Z"
    );
  });

  it("uses the latest configured channel after a delivery was claimed", async () => {
    const store = storeWith([testDelivery()]);
    store.getGuildSettings.mockReturnValue({
      guildId: "guild-1",
      channelId: "channel-2",
      locale: "ja",
      timeZone: "Asia/Tokyo"
    });
    const sender: DiscordMessageSender = { send: vi.fn(async () => ({ id: "message-1" })) };

    await pumpDeliveryQueue({ store, sender });

    expect(sender.send).toHaveBeenCalledWith("channel-2", expect.any(Object));
  });

  it("does not send a claimed delivery after its channel was disabled", async () => {
    const store = storeWith([testDelivery()]);
    store.getGuildSettings.mockReturnValue({
      guildId: "guild-1",
      channelId: undefined,
      locale: "ja",
      timeZone: "Asia/Tokyo"
    });
    const sender: DiscordMessageSender = { send: vi.fn(async () => ({ id: "message-1" })) };

    const result = await pumpDeliveryQueue({ store, sender });

    expect(result.failed).toBe(1);
    expect(sender.send).not.toHaveBeenCalled();
    expect(store.markDeliveryFailed).toHaveBeenCalledOnce();
  });

  it.each([403, 404])("permanently fails and disables an inaccessible channel on %s", async (status) => {
    const store = storeWith([testDelivery()]);
    const sender: DiscordMessageSender = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("Discord channel inaccessible"), { status });
      })
    };
    const result = await pumpDeliveryQueue({ store, sender });
    expect(result).toMatchObject({ failed: 1, disabledChannels: 1 });
    expect(store.markDeliveryFailed).toHaveBeenCalledOnce();
    expect(store.disableGuildChannel).toHaveBeenCalledWith("guild-1", "channel-1");
  });

  it("uses stable nonces and caps exponential retry delays", () => {
    expect(messageForDelivery(testDelivery()).nonce).toBe(messageForDelivery(testDelivery()).nonce);
    expect(retryDelayMilliseconds(new Error("network"), 99)).toBe(3_600_000);
  });
});
