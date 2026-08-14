import { describe, expect, it, vi } from "vitest";
import { AppScheduler } from "../../src/application/scheduler.js";
import type { BotStore } from "../../src/application/ports.js";
import type { AppConfig } from "../../src/core/config.js";
import { createLogger } from "../../src/core/logger.js";
import type { BenchmarkSnapshot, SourceAdapter } from "../../src/domain/models.js";

const config: AppConfig = {
  databasePath: ":memory:",
  backupDir: "./backups",
  timeZone: "Asia/Tokyo",
  digestHour: 7,
  digestMinute: 0,
  logLevel: "error",
  enableMeta: false,
  enableQwen: false,
  enableZai: false,
  enableMoonshot: false
};

function fakeStore(overrides: Partial<BotStore> = {}): BotStore {
  return {
    close: vi.fn(),
    syncActiveSources: vi.fn(),
    recordAdapterContractCheck: vi.fn(),
    getAdapterContractStreak: vi.fn(() => 0),
    getSourceStatus: vi.fn(() => undefined),
    listSourceStatuses: vi.fn(() => []),
    markSourceAttempt: vi.fn(),
    markSourceSuccess: vi.fn(() => []),
    markSourceFailure: vi.fn(() => []),
    processSnapshot: vi.fn(() => ({ baseline: false, changed: false, quarantined: false, events: [] })),
    confirmUnchangedSource: vi.fn(() => []),
    getGuildSettings: vi.fn(() => undefined),
    setGuildChannel: vi.fn(),
    disableGuildChannel: vi.fn(),
    listWatchTargets: vi.fn(() => []),
    setWatchTarget: vi.fn(),
    isWatchTargetEnabled: vi.fn(() => true),
    enqueueImmediateEvents: vi.fn(() => 0),
    reconcileImmediateDeliveries: vi.fn(() => 0),
    enqueueTest: vi.fn(() => "delivery"),
    enqueueDigest: vi.fn(() => 0),
    claimPendingDeliveries: vi.fn(() => []),
    markDeliverySent: vi.fn(),
    markDeliveryRetry: vi.fn(),
    markDeliveryFailed: vi.fn(),
    listRecentEvents: vi.fn(() => []),
    getLeaderboard: vi.fn(() => []),
    prune: vi.fn(() => ({ snapshots: 0, deliveries: 0 })),
    ...overrides
  } as BotStore;
}

describe("AppScheduler", () => {
  it("enqueues the daily digest exactly in the configured Tokyo minute", async () => {
    const store = fakeStore({
      getSourceStatus: vi.fn(() => ({
        sourceId: "openai" as const,
        enabled: true,
        nextPollAt: "2026-08-14T23:00:00.000Z",
        consecutiveFailures: 0,
        health: "healthy" as const
      }))
    });
    const adapter: SourceAdapter = {
      id: "openai",
      displayName: "OpenAI",
      intervalMinutes: 60,
      targets: ["provider-openai"],
      poll: vi.fn(async () => [])
    };
    const pump = vi.fn(async () => undefined);
    const scheduler = new AppScheduler({
      adapters: [adapter],
      config,
      store,
      guildId: "guild",
      logger: createLogger("error"),
      pumpDeliveries: pump,
      now: () => new Date("2026-08-13T22:00:00.000Z")
    });

    await scheduler.tick();

    expect(store.enqueueDigest).toHaveBeenCalledWith(
      "guild",
      "2026-08-14",
      "2026-08-13T22:00:00.000Z"
    );
    expect(adapter.poll).not.toHaveBeenCalled();
    expect(pump).toHaveBeenCalledOnce();
  });

  it("catches up the daily digest after a restart later in the day", async () => {
    const store = fakeStore({
      getSourceStatus: vi.fn(() => ({
        sourceId: "openai" as const,
        enabled: true,
        nextPollAt: "2026-08-14T23:00:00.000Z",
        consecutiveFailures: 0,
        health: "healthy" as const
      }))
    });
    const adapter: SourceAdapter = {
      id: "openai",
      displayName: "OpenAI",
      intervalMinutes: 60,
      targets: ["provider-openai"],
      poll: vi.fn(async () => [])
    };
    const scheduler = new AppScheduler({
      adapters: [adapter],
      config,
      store,
      guildId: "guild",
      logger: createLogger("error"),
      pumpDeliveries: vi.fn(async () => undefined),
      now: () => new Date("2026-08-13T23:12:00.000Z")
    });

    await scheduler.tick();

    expect(store.enqueueDigest).toHaveBeenCalledWith(
      "guild",
      "2026-08-14",
      "2026-08-13T23:12:00.000Z"
    );
  });

  it("catches up retention after 03:15 and runs it once per process day", async () => {
    const store = fakeStore();
    const scheduler = new AppScheduler({
      adapters: [],
      config,
      store,
      guildId: "guild",
      logger: createLogger("error"),
      pumpDeliveries: vi.fn(async () => undefined),
      now: () => new Date("2026-08-13T19:00:00.000Z")
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(store.prune).toHaveBeenCalledOnce();
    expect(store.prune).toHaveBeenCalledWith("2026-08-13T19:00:00.000Z");
  });

  it("backs off a failed source without stopping other work", async () => {
    const store = fakeStore();
    const adapter: SourceAdapter = {
      id: "openai",
      displayName: "OpenAI",
      intervalMinutes: 60,
      targets: ["provider-openai"],
      poll: vi.fn(async () => {
        throw new Error("upstream unavailable");
      })
    };
    const scheduler = new AppScheduler({
      adapters: [adapter],
      config,
      store,
      guildId: "guild",
      logger: createLogger("error"),
      pumpDeliveries: vi.fn(async () => undefined),
      now: () => new Date("2026-08-14T00:00:00.000Z")
    });

    await scheduler.tick();

    expect(store.markSourceFailure).toHaveBeenCalledWith(
      "openai",
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T00:05:00.000Z",
      "upstream unavailable"
    );
  });

  it("polls due sources concurrently and pumps a fast result before a slow poll finishes", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const fastAdapter: SourceAdapter = {
      id: "openai",
      displayName: "OpenAI",
      intervalMinutes: 60,
      targets: ["provider-openai"],
      poll: vi.fn(async () => [])
    };
    const slowAdapter: SourceAdapter = {
      id: "lmarena",
      displayName: "LMArena",
      intervalMinutes: 180,
      targets: ["lmarena-overall"],
      poll: vi.fn(async () => {
        await slow;
        return [];
      })
    };
    const pump = vi.fn(async () => undefined);
    const scheduler = new AppScheduler({
      adapters: [slowAdapter, fastAdapter],
      config,
      store: fakeStore(),
      guildId: "guild",
      logger: createLogger("error"),
      pumpDeliveries: pump,
      now: () => new Date("2026-08-14T00:00:00.000Z")
    });

    const tick = scheduler.tick();
    await vi.waitFor(() => expect(pump).toHaveBeenCalledTimes(1));
    expect(slowAdapter.poll).toHaveBeenCalledOnce();
    releaseSlow();
    await tick;

    // One pump follows each completed source, followed by the final reconcile/digest pump.
    expect(pump).toHaveBeenCalledTimes(3);
  });

  it("keeps the accepted checkpoint when a snapshot is quarantined", async () => {
    const oldCheckpoint = { revision: "accepted-revision", etag: '"accepted"' };
    const snapshot: BenchmarkSnapshot = {
      kind: "benchmark",
      sourceId: "swebench",
      leaderboardId: "swebench-verified",
      leaderboardName: "SWE-bench Verified",
      category: "Verified",
      entityType: "submission",
      sourceUrl: "https://example.test/leaderboard",
      observedAt: "2026-08-14T00:00:00.000Z",
      version: "Verified",
      scorePrecision: 2,
      entries: [],
      checkpoint: { revision: "isolated-revision", etag: '"isolated"' }
    };
    const store = fakeStore({
      getSourceStatus: vi.fn(() => ({
        sourceId: "swebench" as const,
        enabled: true,
        nextPollAt: "2026-08-13T00:00:00.000Z",
        consecutiveFailures: 0,
        health: "healthy" as const,
        checkpoint: oldCheckpoint
      })),
      processSnapshot: vi.fn(() => ({
        baseline: false,
        changed: true,
        quarantined: true,
        events: []
      }))
    });
    const adapter: SourceAdapter = {
      id: "swebench",
      displayName: "SWE-bench",
      intervalMinutes: 360,
      targets: ["swebench-verified"],
      poll: vi.fn(async () => [snapshot])
    };
    const scheduler = new AppScheduler({
      adapters: [adapter],
      config,
      store,
      guildId: "guild",
      logger: createLogger("error"),
      pumpDeliveries: vi.fn(async () => undefined),
      now: () => new Date("2026-08-14T00:00:00.000Z")
    });

    await scheduler.tick();

    expect(store.markSourceSuccess).toHaveBeenCalledWith(
      "swebench",
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T06:00:00.000Z",
      oldCheckpoint
    );
  });

  it("aborts and waits for an in-flight source poll during shutdown", async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        notifyStarted();
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    const store = fakeStore();
    const adapter: SourceAdapter = {
      id: "openai",
      displayName: "OpenAI",
      intervalMinutes: 60,
      targets: ["provider-openai"],
      poll: async (context) => {
        await context.fetch("https://example.test/hanging");
        return [];
      }
    };
    const pump = vi.fn(async () => undefined);
    const scheduler = new AppScheduler({
      adapters: [adapter],
      config,
      store,
      guildId: "guild",
      logger: createLogger("error"),
      pumpDeliveries: pump,
      fetch: hangingFetch,
      now: () => new Date("2026-08-14T00:00:00.000Z")
    });

    const tick = scheduler.tick();
    await started;
    await scheduler.stopAndWait();
    await tick;

    expect(store.markSourceFailure).not.toHaveBeenCalled();
    expect(pump).not.toHaveBeenCalled();
  });
});
