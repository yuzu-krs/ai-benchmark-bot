import type {
  DomainEvent,
  LeaderboardEntry,
  LeaderboardId,
  SourceCheckpoint,
  SourceId,
  SourceSnapshot,
  SourceStatus
} from "../domain/models.js";

export interface GuildSettings {
  guildId: string;
  channelId?: string;
  locale: string;
  timeZone: string;
}

export interface WatchTarget {
  target: string;
  enabled: boolean;
}

export interface Delivery {
  id: string;
  eventId?: string;
  guildId: string;
  channelId: string;
  kind: "event" | "digest" | "test";
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: string;
}

export interface SnapshotResult {
  baseline: boolean;
  changed: boolean;
  quarantined: boolean;
  events: DomainEvent[];
}

export interface BotStore {
  close(): void;
  syncActiveSources(sourceIds: readonly SourceId[], updatedAt: string): void;
  recordAdapterContractCheck(
    sourceId: "meta" | "qwen",
    dateKey: string,
    checkedAt: string,
    success: boolean,
    contractVersion: string,
    errorMessage?: string
  ): void;
  getAdapterContractStreak(
    sourceId: "meta" | "qwen",
    throughDateKey: string,
    contractVersion: string
  ): number;
  getSourceStatus(sourceId: SourceId): SourceStatus | undefined;
  listSourceStatuses(): SourceStatus[];
  markSourceAttempt(sourceId: SourceId, attemptedAt: string): void;
  markSourceSuccess(
    sourceId: SourceId,
    succeededAt: string,
    nextPollAt: string,
    checkpoint: SourceCheckpoint
  ): DomainEvent[];
  markSourceFailure(
    sourceId: SourceId,
    failedAt: string,
    nextPollAt: string,
    errorMessage: string
  ): DomainEvent[];
  processSnapshot(snapshot: SourceSnapshot): SnapshotResult;
  confirmUnchangedSource(sourceId: SourceId, observedAt: string): DomainEvent[];
  getGuildSettings(guildId: string): GuildSettings | undefined;
  setGuildChannel(guildId: string, channelId: string, timeZone: string): GuildSettings;
  disableGuildChannel(guildId: string, channelId: string): void;
  listWatchTargets(guildId: string): WatchTarget[];
  setWatchTarget(guildId: string, target: string, enabled: boolean): void;
  isWatchTargetEnabled(guildId: string, target: string): boolean;
  enqueueImmediateEvents(events: DomainEvent[], guildId: string): number;
  reconcileImmediateDeliveries(guildId: string): number;
  enqueueTest(guildId: string, channelId: string): string;
  enqueueDigest(guildId: string, dateKey: string, now: string, force?: boolean): number;
  claimPendingDeliveries(now: string, limit: number): Delivery[];
  markDeliverySent(deliveryId: string, discordMessageId: string, sentAt: string): void;
  markDeliveryRetry(deliveryId: string, errorMessage: string, nextAttemptAt: string): void;
  markDeliveryFailed(deliveryId: string, errorMessage: string): void;
  listRecentEvents(since: string, limit: number): DomainEvent[];
  getLeaderboard(leaderboardId: LeaderboardId, limit: number): LeaderboardEntry[];
  prune(now: string): { snapshots: number; deliveries: number };
}
