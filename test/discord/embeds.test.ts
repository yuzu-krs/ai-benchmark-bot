import { describe, expect, it } from "vitest";
import type { Delivery } from "../../src/application/ports.js";
import type { DomainEvent } from "../../src/domain/models.js";
import {
  buildDigestEmbed,
  buildEventEmbed,
  embedsForDelivery,
  truncate
} from "../../src/discord/embeds.js";

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: "event-1",
    fingerprint: "fingerprint-1",
    type: "benchmark.rank_changed",
    sourceId: "lmarena",
    leaderboardId: "lmarena-overall",
    occurredAt: "2026-08-14T00:00:00.000Z",
    detectedAt: "2026-08-14T00:01:00.000Z",
    immediate: true,
    payload: {
      sourceId: "lmarena",
      leaderboardId: "lmarena-overall",
      entityKey: "model-a",
      entityName: "Model A",
      oldRank: 12,
      newRank: 9
    },
    ...overrides
  };
}

describe("Discord embeds", () => {
  it("truncates within Discord limits without splitting a surrogate pair", () => {
    expect(truncate(`1234😀5678`, 6)).toBe("1234…");
    expect(truncate("short", 10)).toBe("short");
  });

  it("renders Japanese event details and an official attribution link", () => {
    const embed = buildEventEmbed(event());
    expect(embed.title).toBe("ランキング変動");
    expect(embed.description).toContain("12位");
    expect(embed.description).toContain("9位");
    expect(embed.fields?.at(-1)?.value).toContain("huggingface.co/datasets/lmarena-ai");
  });

  it("labels a Moonshot catalog addition as availability rather than an announcement", () => {
    const embed = buildEventEmbed(
      event({
        type: "provider.model_available",
        sourceId: "moonshot",
        leaderboardId: undefined,
        payload: {
          sourceId: "moonshot",
          title: "Kimi K3",
          url: "https://platform.kimi.ai/docs/models"
        }
      })
    );
    expect(embed.title).toBe("公式モデル一覧への追加");
    expect(embed.description).toContain("公式モデル一覧へ追加");
    expect(embed.description).not.toContain("発表されました");
  });

  it("keeps large digests within embed field limits", () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      event({
        id: `event-${index}`,
        payload: {
          ...event().payload,
          entityName: `長いモデル名-${index}-${"x".repeat(200)}`
        },
        immediate: index % 2 === 0
      })
    );
    const embed = buildDigestEmbed(events, "2026-08-14");
    expect(embed.fields?.length).toBeLessThanOrEqual(25);
    for (const field of embed.fields ?? []) expect(field.value.length).toBeLessThanOrEqual(1_024);
    expect(embed.fields?.find((field) => field.name === "公式出典")?.value).toContain(
      "huggingface.co/datasets/lmarena-ai"
    );
    expect(embed.fields?.find((field) => field.name === "省略")?.value).toBe("ほか 72 件");
  });

  it("reports omitted regular events starting at the nineteenth item", () => {
    const events = Array.from({ length: 20 }, (_, index) =>
      event({ id: `event-${index}`, immediate: false })
    );
    const embed = buildDigestEmbed(events, "2026-08-14");
    expect(embed.fields?.find((field) => field.name === "省略")?.value).toBe("ほか 2 件");
  });

  it("reports the full digest count even when the delivery payload is bounded", () => {
    const events = Array.from({ length: 28 }, (_, index) =>
      event({ id: `event-${index}`, immediate: false })
    );
    const embed = buildDigestEmbed(events, "2026-08-14", 1_500);
    expect(embed.description).toContain("1500件");
    expect(embed.fields?.find((field) => field.name === "省略")?.value).toBe("ほか 1482 件");
  });

  it("attributes sources that only occur in omitted digest events", () => {
    const delivery: Delivery = {
      id: "delivery-digest",
      guildId: "guild-1",
      channelId: "channel-1",
      kind: "digest",
      payload: {
        dateKey: "2026-08-14",
        events: [event({ sourceId: "openai", leaderboardId: undefined })],
        totalCount: 100,
        sourceIds: ["openai", "lmarena"]
      },
      attempts: 0,
      nextAttemptAt: "2026-08-14T00:00:00.000Z"
    };

    const attribution = embedsForDelivery(delivery)[0]?.fields?.find(
      (field) => field.name === "公式出典"
    )?.value;
    expect(attribution).toContain("developers.openai.com");
    expect(attribution).toContain("huggingface.co/datasets/lmarena-ai");
  });

  it("accepts the canonical event delivery payload", () => {
    const delivery: Delivery = {
      id: "delivery-1",
      guildId: "guild-1",
      channelId: "channel-1",
      kind: "event",
      payload: { event: event() },
      attempts: 0,
      nextAttemptAt: "2026-08-14T00:00:00.000Z"
    };
    expect(embedsForDelivery(delivery)[0]?.title).toBe("ランキング変動");
  });
});
