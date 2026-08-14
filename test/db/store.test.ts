import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BotStore } from "../../src/application/ports.js";
import { backupDatabase, createStore } from "../../src/db/store.js";
import type {
  AnnouncementItem,
  AnnouncementSnapshot,
  BenchmarkSnapshot,
  LeaderboardEntry
} from "../../src/domain/models.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function leaderboardEntry(index: number, overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  const score = 100 - index;
  return {
    entityKey: `model-${index}`,
    name: `Model ${index}`,
    rank: index,
    score,
    scoreDisplay: score.toFixed(2),
    ...overrides
  };
}

function benchmark(
  observedAt: string,
  entries: LeaderboardEntry[],
  overrides: Partial<BenchmarkSnapshot> = {}
): BenchmarkSnapshot {
  return {
    kind: "benchmark",
    sourceId: "lmarena",
    leaderboardId: "lmarena-overall",
    leaderboardName: "LMArena Overall",
    category: "overall",
    entityType: "model",
    sourceUrl: "https://example.test/lmarena",
    observedAt,
    version: "text_style_control-v1",
    scorePrecision: 2,
    entries,
    checkpoint: { revision: observedAt },
    ...overrides
  };
}

function announcementItem(
  itemKey: string,
  confidence: "confirmed" | "candidate" = "confirmed"
): AnnouncementItem {
  return {
    itemKey,
    title: `Model ${itemKey}`,
    url: `https://example.test/${itemKey}`,
    publishedAt: "2026-08-14T01:00:00.000Z",
    summary: "A model release.",
    modelIds: [itemKey],
    stage: "general_availability",
    confidence,
    modality: "text"
  };
}

function announcements(observedAt: string, items: AnnouncementItem[]): AnnouncementSnapshot {
  return {
    kind: "announcements",
    sourceId: "openai",
    providerName: "OpenAI",
    sourceUrl: "https://example.test/changelog",
    observedAt,
    items,
    checkpoint: { contentHash: observedAt }
  };
}

describe("SqliteBotStore", () => {
  let store: BotStore;

  beforeEach(() => {
    store = createStore();
  });

  afterEach(() => {
    store.close();
  });

  it("synchronizes configured source adapters for an accurate status", () => {
    store.syncActiveSources(
      ["lmarena", "swebench", "openai", "anthropic", "google", "mistral", "xai", "deepseek"],
      "2026-08-14T00:00:00.000Z"
    );

    expect(store.getSourceStatus("openai")?.enabled).toBe(true);
    expect(store.getSourceStatus("meta")?.enabled).toBe(false);
    expect(store.getSourceStatus("qwen")?.enabled).toBe(false);

    store.syncActiveSources(
      ["lmarena", "swebench", "openai", "anthropic", "google", "mistral", "xai", "deepseek", "meta"],
      "2026-08-14T01:00:00.000Z"
    );
    expect(store.getSourceStatus("meta")?.enabled).toBe(true);
    expect(store.getSourceStatus("meta")?.nextPollAt).toBeUndefined();
  });

  it("saves an initial baseline without events and skips an identical poll", () => {
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    const first = store.processSnapshot(benchmark("2026-08-14T00:00:00.000Z", entries));
    const duplicate = store.processSnapshot(benchmark("2026-08-14T03:00:00.000Z", [...entries].reverse()));

    expect(first).toMatchObject({ baseline: true, changed: true, quarantined: false, events: [] });
    expect(duplicate).toMatchObject({ baseline: false, changed: false, events: [] });
    expect(store.getLeaderboard("lmarena-overall", 20)).toHaveLength(10);
    expect(store.listRecentEvents("2026-01-01T00:00:00.000Z", 100)).toEqual([]);
  });

  it("emits a definition event when an explicit benchmark version changes", () => {
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(
      benchmark("2026-08-14T00:00:00.000Z", entries, { version: "method-v1" })
    );

    const result = store.processSnapshot(
      benchmark("2026-08-14T03:00:00.000Z", entries, { version: "method-v2" })
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "benchmark.definition_changed",
      immediate: true
    });
  });

  it("emits separate first-seen, rank, score and verification events", () => {
    const entries = Array.from({ length: 20 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2026-08-14T00:00:00.000Z", entries));
    const changedEntries = entries.map((item) =>
      item.entityKey === "model-12"
        ? {
            ...item,
            rank: 9,
            score: item.score + 1,
            scoreDisplay: (item.score + 1).toFixed(2),
            verified: true
          }
        : item
    );
    changedEntries.push(leaderboardEntry(21));

    const result = store.processSnapshot(benchmark("2026-08-14T03:00:00.000Z", changedEntries));
    const types = result.events.map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "benchmark.entity_first_seen",
        "benchmark.rank_changed",
        "benchmark.score_changed",
        "benchmark.verification_changed"
      ])
    );
    expect(result.events.find((event) => event.type === "benchmark.rank_changed")?.immediate).toBe(
      true
    );
    expect(result.events.find((event) => event.type === "benchmark.score_changed")?.immediate).toBe(
      false
    );
  });

  it("requires two consecutive missing observations without storing a duplicate snapshot", () => {
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2026-08-14T00:00:00.000Z", entries));
    const withoutLast = entries.slice(0, 9);

    const firstMissing = store.processSnapshot(
      benchmark("2026-08-14T03:00:00.000Z", withoutLast)
    );
    const confirmed = store.processSnapshot(benchmark("2026-08-14T06:00:00.000Z", withoutLast));
    const duplicate = store.processSnapshot(benchmark("2026-08-14T09:00:00.000Z", withoutLast));

    expect(firstMissing.events.some((event) => event.type === "benchmark.entity_removed")).toBe(false);
    expect(confirmed.changed).toBe(false);
    expect(confirmed.events).toHaveLength(1);
    expect(confirmed.events[0]).toMatchObject({
      type: "benchmark.entity_removed",
      immediate: true,
      payload: { entityKey: "model-10" }
    });
    expect(duplicate.events).toEqual([]);
  });

  it("confirms pending removals when a source returns no snapshots for an unchanged revision", () => {
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2026-08-14T00:00:00.000Z", entries));
    store.processSnapshot(benchmark("2026-08-14T03:00:00.000Z", entries.slice(0, 9)));

    const confirmed = store.confirmUnchangedSource("lmarena", "2026-08-14T06:00:00.000Z");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      type: "benchmark.entity_removed",
      payload: { entityKey: "model-10" }
    });
    expect(store.confirmUnchangedSource("lmarena", "2026-08-14T09:00:00.000Z")).toEqual([]);
  });

  it("quarantines a threshold anomaly and promotes only a repeated non-empty anomaly", () => {
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2026-08-14T00:00:00.000Z", entries));
    const shortened = entries.slice(0, 8);

    const quarantine = store.processSnapshot(benchmark("2026-08-14T03:00:00.000Z", shortened));
    expect(quarantine).toMatchObject({ quarantined: true, events: [] });
    expect(store.getLeaderboard("lmarena-overall", 20)).toHaveLength(10);

    const promoted = store.processSnapshot(benchmark("2026-08-14T06:00:00.000Z", shortened));
    expect(promoted).toMatchObject({ quarantined: false, changed: true });
    expect(promoted.events.map((event) => event.type)).toEqual(["benchmark.definition_changed"]);
    expect(store.getLeaderboard("lmarena-overall", 20)).toHaveLength(8);
  });

  it("never lets an empty response replace a good baseline", () => {
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2026-08-14T00:00:00.000Z", entries));

    const first = store.processSnapshot(benchmark("2026-08-14T03:00:00.000Z", []));
    const repeated = store.processSnapshot(benchmark("2026-08-14T06:00:00.000Z", []));
    expect(first.quarantined).toBe(true);
    expect(repeated.quarantined).toBe(true);
    expect(repeated.events).toEqual([]);
    expect(store.getLeaderboard("lmarena-overall", 20)).toHaveLength(10);
  });

  it("keeps official announcements distinct, baselines silently, and de-duplicates items", () => {
    const original = announcementItem("gpt-a");
    const baseline = store.processSnapshot(
      announcements("2026-08-14T00:00:00.000Z", [original])
    );
    expect(baseline.baseline).toBe(true);

    const confirmed = announcementItem("gpt-b");
    const candidate = announcementItem("gpt-c", "candidate");
    const next = announcements("2026-08-14T02:00:00.000Z", [original, confirmed, candidate]);
    const changed = store.processSnapshot(next);
    expect(changed.events.map((event) => [event.type, event.immediate])).toEqual(
      expect.arrayContaining([
        ["provider.model_announced", true],
        ["provider.announcement_candidate", false]
      ])
    );
    expect(store.processSnapshot(next)).toMatchObject({ changed: false, events: [] });
  });

  it("accepts an empty filtered announcement feed so the first later model is notified", () => {
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");
    const empty = store.processSnapshot(announcements("2099-08-14T00:00:00.000Z", []));
    expect(empty).toMatchObject({ baseline: true, quarantined: false, events: [] });

    const firstModel = store.processSnapshot(
      announcements("2099-08-14T01:00:00.000Z", [announcementItem("gpt-first")])
    );
    expect(firstModel.events.map((event) => event.type)).toEqual(["provider.model_announced"]);
    expect(store.enqueueImmediateEvents(firstModel.events, "guild")).toBe(1);
    const delivery = store.claimPendingDeliveries("2099-08-14T01:00:00.000Z", 1)[0];
    expect(delivery?.payload).toMatchObject({
      event: { type: "provider.model_announced" }
    });
  });

  it("keeps an official catalog addition distinct from a model announcement", () => {
    const baseline = announcements("2099-08-14T00:00:00.000Z", []);
    baseline.sourceId = "moonshot";
    baseline.providerName = "Moonshot AI";
    store.processSnapshot(baseline);

    const available = announcementItem("kimi-k3");
    available.title = "Kimi K3";
    available.eventKind = "availability";
    const next = announcements("2099-08-14T01:00:00.000Z", [available]);
    next.sourceId = "moonshot";
    next.providerName = "Moonshot AI";
    const result = store.processSnapshot(next);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "provider.model_available",
      immediate: true,
      payload: { metadata: { eventKind: "availability" } }
    });
  });

  it("does not suppress a legitimate A-to-B rank oscillation on a later source revision", () => {
    const original = Array.from({ length: 20 }, (_, index) => leaderboardEntry(index + 1));
    const moved = original.map((item) =>
      item.entityKey === "model-12" ? { ...item, rank: 9 } : item
    );
    store.processSnapshot(benchmark("2026-08-14T00:00:00.000Z", original));
    store.processSnapshot(benchmark("2026-08-14T03:00:00.000Z", moved));
    store.processSnapshot(benchmark("2026-08-14T06:00:00.000Z", original));
    store.processSnapshot(benchmark("2026-08-14T09:00:00.000Z", moved));

    const rankEvents = store
      .listRecentEvents("2026-08-14T00:00:00.000Z", 100)
      .filter(
        (event) =>
          event.type === "benchmark.rank_changed" && event.payload.entityKey === "model-12"
      );
    expect(rankEvents).toHaveLength(3);
  });

  it("degrades on the third failure and recovers once after success", () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const time = `2026-08-14T0${attempt}:00:00.000Z`;
      store.markSourceAttempt("openai", time);
      const events = store.markSourceFailure(
        "openai",
        time,
        `2026-08-14T0${attempt + 1}:00:00.000Z`,
        "network unavailable"
      );
      expect(events).toHaveLength(attempt === 3 ? 1 : 0);
    }
    expect(store.getSourceStatus("openai")).toMatchObject({
      consecutiveFailures: 3,
      health: "degraded"
    });

    const recovered = store.markSourceSuccess(
      "openai",
      "2026-08-14T04:00:00.000Z",
      "2026-08-14T05:00:00.000Z",
      { revision: "ok" }
    );
    expect(recovered.map((event) => event.type)).toEqual(["source.recovered"]);
    expect(store.getSourceStatus("openai")).toMatchObject({
      consecutiveFailures: 0,
      health: "healthy",
      checkpoint: { revision: "ok" }
    });
  });

  it("reports a seven-day adapter contract success streak through the requested date", () => {
    for (let day = 8; day <= 14; day += 1) {
      const dateKey = `2026-08-${String(day).padStart(2, "0")}`;
      store.recordAdapterContractCheck(
        "meta",
        dateKey,
        `${dateKey}T03:00:00.000Z`,
        true,
        "meta-html-v1"
      );
    }
    expect(store.getAdapterContractStreak("meta", "2026-08-14", "meta-html-v1")).toBe(7);
    expect(store.getAdapterContractStreak("meta", "2026-08-13", "meta-html-v1")).toBe(6);
  });

  it("stops an adapter contract streak at a missing day", () => {
    store.recordAdapterContractCheck(
      "qwen",
      "2026-08-12",
      "2026-08-12T03:00:00.000Z",
      true,
      "qwen-json-v1"
    );
    store.recordAdapterContractCheck(
      "qwen",
      "2026-08-14",
      "2026-08-14T03:00:00.000Z",
      true,
      "qwen-json-v1"
    );
    expect(store.getAdapterContractStreak("qwen", "2026-08-14", "qwen-json-v1")).toBe(1);
    expect(store.getAdapterContractStreak("qwen", "2026-08-13", "qwen-json-v1")).toBe(1);
  });

  it("stops at a failed contract check and keeps the latest same-day result", () => {
    store.recordAdapterContractCheck(
      "meta",
      "2026-08-12",
      "2026-08-12T03:00:00.000Z",
      true,
      "meta-html-v1"
    );
    store.recordAdapterContractCheck(
      "meta",
      "2026-08-13",
      "2026-08-13T03:00:00.000Z",
      false,
      "meta-html-v1",
      "selector missing"
    );
    store.recordAdapterContractCheck(
      "meta",
      "2026-08-14",
      "2026-08-14T03:00:00.000Z",
      true,
      "meta-html-v1"
    );
    expect(store.getAdapterContractStreak("meta", "2026-08-14", "meta-html-v1")).toBe(1);

    store.recordAdapterContractCheck(
      "meta",
      "2026-08-13",
      "2026-08-13T04:00:00.000Z",
      true,
      "meta-html-v1"
    );
    store.recordAdapterContractCheck(
      "meta",
      "2026-08-13",
      "2026-08-13T02:00:00.000Z",
      false,
      "meta-html-v1",
      "stale failure"
    );
    expect(store.getAdapterContractStreak("meta", "2026-08-14", "meta-html-v1")).toBe(3);
  });

  it("stops an adapter contract streak when the contract version changes", () => {
    store.recordAdapterContractCheck(
      "qwen",
      "2026-08-13",
      "2026-08-13T03:00:00.000Z",
      true,
      "qwen-json-v1"
    );
    store.recordAdapterContractCheck(
      "qwen",
      "2026-08-14",
      "2026-08-14T03:00:00.000Z",
      true,
      "qwen-json-v2"
    );
    expect(store.getAdapterContractStreak("qwen", "2026-08-14", "qwen-json-v2")).toBe(1);
    expect(store.getAdapterContractStreak("qwen", "2026-08-14", "qwen-json-v1")).toBe(1);
  });

  it("retains a previously achieved seven-day gate across later failure and missing days", () => {
    for (let day = 1; day <= 7; day += 1) {
      const dateKey = `2026-08-${String(day).padStart(2, "0")}`;
      store.recordAdapterContractCheck(
        "meta",
        dateKey,
        `${dateKey}T03:00:00.000Z`,
        true,
        "meta-html-v1"
      );
    }
    store.recordAdapterContractCheck(
      "meta",
      "2026-08-08",
      "2026-08-08T03:00:00.000Z",
      false,
      "meta-html-v1",
      "temporary selector failure"
    );

    expect(store.getAdapterContractStreak("meta", "2026-08-08", "meta-html-v1")).toBe(7);
    expect(store.getAdapterContractStreak("meta", "2026-08-10", "meta-html-v1")).toBe(7);
    expect(store.getAdapterContractStreak("meta", "2026-08-10", "meta-html-v2")).toBe(0);
  });

  it("validates adapter contract gate inputs before writing", () => {
    expect(() =>
      store.recordAdapterContractCheck(
        "openai" as "meta",
        "2026-08-14",
        "2026-08-14T03:00:00.000Z",
        true,
        "v1"
      )
    ).toThrow(/unsupported/);
    expect(() =>
      store.recordAdapterContractCheck(
        "meta",
        "2026-02-30",
        "2026-08-14T03:00:00.000Z",
        true,
        "v1"
      )
    ).toThrow(/valid calendar date/);
    expect(() =>
      store.recordAdapterContractCheck(
        "meta",
        "2026-08-14",
        "not-a-timestamp",
        true,
        "v1"
      )
    ).toThrow(/valid timestamp/);
    expect(() => store.getAdapterContractStreak("meta", "2026-08-14", "   ")).toThrow(
      /contractVersion/
    );
  });

  it("uses a unique event/subscription outbox and reclaims retried deliveries", () => {
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2026-08-14T00:00:00.000Z", entries));
    const result = store.processSnapshot(
      benchmark("2026-08-14T03:00:00.000Z", [...entries, leaderboardEntry(11)])
    );

    expect(store.enqueueImmediateEvents(result.events, "guild")).toBe(1);
    expect(store.enqueueImmediateEvents(result.events, "guild")).toBe(0);
    const claimed = store.claimPendingDeliveries("2026-08-14T03:00:00.000Z", 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.payload).toHaveProperty("event");
    expect(claimed[0]?.attempts).toBe(1);

    store.markDeliveryRetry(
      claimed[0]!.id,
      "rate limited",
      "2026-08-14T03:05:00.000Z"
    );
    expect(store.claimPendingDeliveries("2026-08-14T03:04:59.000Z", 10)).toEqual([]);
    expect(store.claimPendingDeliveries("2026-08-14T03:05:00.000Z", 10)[0]?.attempts).toBe(2);
  });

  it("reconciles an event committed before its immediate outbox insert", () => {
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2099-08-14T00:00:00.000Z", entries));
    store.processSnapshot(
      benchmark("2099-08-14T03:00:00.000Z", [...entries, leaderboardEntry(11)])
    );

    expect(store.reconcileImmediateDeliveries("guild")).toBe(1);
    expect(store.reconcileImmediateDeliveries("guild")).toBe(0);
    expect(store.claimPendingDeliveries("2099-08-14T03:00:00.000Z", 10)).toHaveLength(1);
  });

  it("does not redeliver an event after its 30-day delivery log is pruned", () => {
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2099-01-01T00:00:00.000Z", entries));
    const changed = store.processSnapshot(
      benchmark("2099-01-02T00:00:00.000Z", [...entries, leaderboardEntry(11)])
    );
    expect(store.enqueueImmediateEvents(changed.events, "guild")).toBe(1);
    const sent = store.claimPendingDeliveries("2099-01-02T00:00:01.000Z", 1);
    expect(sent).toHaveLength(1);
    store.markDeliverySent(sent[0]!.id, "discord-message", "2099-01-02T00:00:02.000Z");

    expect(store.prune("2099-02-03T00:00:00.000Z").deliveries).toBe(1);
    expect(store.reconcileImmediateDeliveries("guild")).toBe(0);
    expect(store.claimPendingDeliveries("2099-02-03T00:00:00.000Z", 10)).toEqual([]);
  });

  it("does not redeliver a source health event when its selected watch subscription changes", () => {
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");
    let healthEvents = [] as ReturnType<BotStore["markSourceFailure"]>;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failedAt = `2099-01-0${attempt}T00:00:00.000Z`;
      healthEvents = store.markSourceFailure(
        "lmarena",
        failedAt,
        `2099-01-0${attempt + 1}T00:00:00.000Z`,
        "unavailable"
      );
    }
    expect(healthEvents.map((event) => event.type)).toEqual(["source.degraded"]);
    expect(store.enqueueImmediateEvents(healthEvents, "guild")).toBe(1);

    store.setWatchTarget("guild", "lmarena-overall", false);
    expect(store.isWatchTargetEnabled("guild", "lmarena-coding")).toBe(true);
    expect(store.reconcileImmediateDeliveries("guild")).toBe(0);
    expect(store.claimPendingDeliveries("2099-01-04T00:00:00.000Z", 10)).toHaveLength(1);
  });

  it("defaults staged and terms-review provider watches off and permits an explicit enable", () => {
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");
    const watches = new Map(
      store.listWatchTargets("guild").map((target) => [target.target, target.enabled])
    );
    expect(watches.get("provider-meta")).toBe(false);
    expect(watches.get("provider-qwen")).toBe(false);
    expect(watches.get("provider-zai")).toBe(false);
    expect(watches.get("provider-moonshot")).toBe(false);
    const optInTargets = new Set([
      "provider-meta",
      "provider-qwen",
      "provider-zai",
      "provider-moonshot"
    ]);
    expect(
      [...watches.entries()]
        .filter(([target]) => !optInTargets.has(target))
        .every(([, enabled]) => enabled)
    ).toBe(true);
    expect(store.isWatchTargetEnabled("unconfigured-guild", "provider-meta")).toBe(false);
    expect(store.isWatchTargetEnabled("unconfigured-guild", "provider-zai")).toBe(false);
    store.setWatchTarget("guild", "provider-meta", true);
    expect(store.isWatchTargetEnabled("guild", "provider-meta")).toBe(true);

    store.setWatchTarget("guild", "lmarena-overall", false);
    expect(store.isWatchTargetEnabled("guild", "lmarena-overall")).toBe(false);

    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2026-08-14T00:00:00.000Z", entries));
    const result = store.processSnapshot(
      benchmark("2026-08-14T03:00:00.000Z", [...entries, leaderboardEntry(11)])
    );
    expect(store.enqueueImmediateEvents(result.events, "guild")).toBe(0);
  });

  it("creates at most one scheduled digest per date but permits a forced rerun", () => {
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2099-08-14T00:00:00.000Z", entries));
    const scored = entries.map((item) =>
      item.entityKey === "model-5"
        ? { ...item, score: item.score + 0.5, scoreDisplay: (item.score + 0.5).toFixed(2) }
        : item
    );
    store.processSnapshot(benchmark("2099-08-14T01:00:00.000Z", scored));

    expect(store.enqueueDigest("guild", "2099-08-14", "2099-08-14T07:00:00.000Z")).toBe(1);
    expect(store.enqueueDigest("guild", "2099-08-14", "2099-08-14T07:01:00.000Z")).toBe(0);
    expect(
      store.enqueueDigest("guild", "2099-08-14", "2099-08-14T07:02:00.000Z", true)
    ).toBe(1);
    const deliveries = store.claimPendingDeliveries("2099-08-14T07:02:00.000Z", 10);
    expect(deliveries.filter((delivery) => delivery.kind === "digest")).toHaveLength(2);
  });

  it("does not digest events detected before channel setup or the latest watch enable", () => {
    const now = Date.now();
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark(new Date(now - 120_000).toISOString(), entries));
    const scored = entries.map((item) =>
      item.entityKey === "model-5"
        ? { ...item, score: item.score + 0.5, scoreDisplay: (item.score + 0.5).toFixed(2) }
        : item
    );
    store.processSnapshot(benchmark(new Date(now - 60_000).toISOString(), scored));
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");

    expect(
      store.enqueueDigest("guild", "setup-cutoff", new Date(now + 60_000).toISOString(), true)
    ).toBe(0);

    store.setWatchTarget("guild", "lmarena-overall", false);
    const rescored = scored.map((item) =>
      item.entityKey === "model-6"
        ? { ...item, score: item.score + 0.5, scoreDisplay: (item.score + 0.5).toFixed(2) }
        : item
    );
    store.processSnapshot(benchmark(new Date(now - 30_000).toISOString(), rescored));
    store.setWatchTarget("guild", "lmarena-overall", true);

    expect(
      store.enqueueDigest("guild", "watch-cutoff", new Date(now + 60_000).toISOString(), true)
    ).toBe(0);
  });

  it("disables only the matching configured channel and fails its pending deliveries", () => {
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");
    store.enqueueTest("guild", "channel");
    store.disableGuildChannel("guild", "different-channel");
    expect(store.getGuildSettings("guild")?.channelId).toBe("channel");
    store.disableGuildChannel("guild", "channel");
    expect(store.getGuildSettings("guild")?.channelId).toBeUndefined();
    expect(store.claimPendingDeliveries(new Date().toISOString(), 10)).toEqual([]);
  });

  it("retargets pending deliveries and releases claimed deliveries when the channel changes", () => {
    store.setGuildChannel("guild", "old-channel", "Asia/Tokyo");
    store.enqueueTest("guild", "old-channel");
    store.enqueueTest("guild", "old-channel");
    const firstClaim = store.claimPendingDeliveries("2099-01-01T00:00:00.000Z", 1);
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]?.channelId).toBe("old-channel");

    store.setGuildChannel("guild", "new-channel", "Asia/Tokyo");
    const retargeted = store.claimPendingDeliveries("2099-01-01T00:01:00.000Z", 10);
    expect(retargeted).toHaveLength(2);
    expect(retargeted.every((delivery) => delivery.channelId === "new-channel")).toBe(true);
    expect(retargeted.map((delivery) => delivery.attempts).sort()).toEqual([1, 2]);
  });

  it("prunes one-year snapshots/events and 30-day delivery logs without deleting the current view", () => {
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2024-01-01T00:00:00.000Z", entries));
    const changed = store.processSnapshot(
      benchmark("2024-02-01T00:00:00.000Z", [...entries, leaderboardEntry(11)])
    );
    expect(store.enqueueImmediateEvents(changed.events, "guild")).toBe(1);
    const claimed = store.claimPendingDeliveries("2024-02-01T00:01:00.000Z", 1);
    expect(claimed).toHaveLength(1);
    store.markDeliverySent(claimed[0]!.id, "discord-message", "2024-02-01T00:01:01.000Z");

    const result = store.prune("2026-08-14T00:00:00.000Z");
    expect(result).toEqual({ snapshots: 1, deliveries: 1 });
    expect(store.getLeaderboard("lmarena-overall", 20)).toHaveLength(11);
    expect(store.listRecentEvents("2020-01-01T00:00:00.000Z", 100)).toEqual([]);
  });

  it("never prunes an unsent outbox item merely because it is older than 30 days", () => {
    store.setGuildChannel("guild", "channel", "Asia/Tokyo");
    const entries = Array.from({ length: 10 }, (_, index) => leaderboardEntry(index + 1));
    store.processSnapshot(benchmark("2026-05-01T00:00:00.000Z", entries));
    const changed = store.processSnapshot(
      benchmark("2026-06-01T00:00:00.000Z", [...entries, leaderboardEntry(11)])
    );
    expect(store.enqueueImmediateEvents(changed.events, "guild")).toBe(1);

    expect(store.prune("2026-08-14T00:00:00.000Z").deliveries).toBe(0);
    expect(store.claimPendingDeliveries("2026-08-14T00:00:01.000Z", 10)).toHaveLength(1);
  });

  it("creates a consistent SQLite online backup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-benchmark-bot-"));
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backups", "backup.sqlite");
    let restored: BotStore | undefined;
    try {
      const fileStore = createStore(sourcePath);
      const entries = Array.from({ length: 3 }, (_, index) => leaderboardEntry(index + 1));
      fileStore.processSnapshot(benchmark("2026-08-14T00:00:00.000Z", entries));
      fileStore.close();

      await backupDatabase(sourcePath, backupPath);
      restored = createStore(backupPath);
      expect(restored.getLeaderboard("lmarena-overall", 10)).toHaveLength(3);
    } finally {
      restored?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
