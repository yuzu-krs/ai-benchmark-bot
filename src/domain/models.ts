export const SOURCE_IDS = [
  "lmarena",
  "swebench",
  "openai",
  "anthropic",
  "google",
  "mistral",
  "xai",
  "deepseek",
  "zai",
  "moonshot",
  "meta",
  "qwen"
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export const LEADERBOARD_IDS = [
  "lmarena-overall",
  "lmarena-coding",
  "swebench-verified"
] as const;

export type LeaderboardId = (typeof LEADERBOARD_IDS)[number];

export const WATCH_TARGETS = [
  ...LEADERBOARD_IDS,
  "provider-openai",
  "provider-anthropic",
  "provider-google",
  "provider-mistral",
  "provider-xai",
  "provider-deepseek",
  "provider-zai",
  "provider-moonshot",
  "provider-meta",
  "provider-qwen"
] as const;

export type WatchTargetId = (typeof WATCH_TARGETS)[number];

export const EVENT_TYPES = [
  "provider.model_announced",
  "provider.model_available",
  "provider.announcement_candidate",
  "benchmark.entity_first_seen",
  "benchmark.entity_removed",
  "benchmark.rank_changed",
  "benchmark.score_changed",
  "benchmark.verification_changed",
  "benchmark.definition_changed",
  "source.degraded",
  "source.recovered"
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type ReleaseStage =
  | "preview"
  | "general_availability"
  | "open_weights"
  | "research_preview"
  | "unknown";

export interface SourceCheckpoint {
  etag?: string;
  lastModified?: string;
  revision?: string;
  contentHash?: string;
}

export interface LeaderboardEntry {
  entityKey: string;
  name: string;
  organization?: string;
  rank: number;
  score: number;
  scoreDisplay: string;
  verified?: boolean;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkSnapshot {
  kind: "benchmark";
  sourceId: SourceId;
  leaderboardId: LeaderboardId;
  leaderboardName: string;
  category: string;
  entityType: "model" | "submission";
  sourceUrl: string;
  observedAt: string;
  sourceUpdatedAt?: string;
  version: string;
  scorePrecision: number;
  entries: LeaderboardEntry[];
  checkpoint: SourceCheckpoint;
}

export interface AnnouncementItem {
  itemKey: string;
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
  modelIds: string[];
  stage: ReleaseStage;
  confidence: "confirmed" | "candidate";
  modality: "text" | "multimodal_text" | "coding" | "agent" | "unknown";
  eventKind?: "announcement" | "availability";
}

export interface AnnouncementSnapshot {
  kind: "announcements";
  sourceId: SourceId;
  providerName: string;
  sourceUrl: string;
  observedAt: string;
  items: AnnouncementItem[];
  checkpoint: SourceCheckpoint;
}

export type SourceSnapshot = BenchmarkSnapshot | AnnouncementSnapshot;

export interface SourceAdapterContext {
  checkpoint?: SourceCheckpoint;
  fetch: typeof globalThis.fetch;
  now: Date;
  githubToken?: string;
  huggingFaceToken?: string;
}

export interface SourceAdapter {
  readonly id: SourceId;
  readonly displayName: string;
  readonly intervalMinutes: number;
  readonly targets: readonly string[];
  poll(context: SourceAdapterContext): Promise<SourceSnapshot[]>;
}

export interface DomainEventPayload {
  sourceId: SourceId;
  leaderboardId?: LeaderboardId;
  entityKey?: string;
  entityName?: string;
  oldRank?: number;
  newRank?: number;
  oldScore?: number;
  newScore?: number;
  verified?: boolean;
  title?: string;
  url?: string;
  stage?: ReleaseStage;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface DomainEvent {
  id: string;
  fingerprint: string;
  type: EventType;
  sourceId: SourceId;
  leaderboardId?: LeaderboardId;
  occurredAt: string;
  detectedAt: string;
  immediate: boolean;
  payload: DomainEventPayload;
}

export interface SourceStatus {
  sourceId: SourceId;
  enabled: boolean;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  nextPollAt?: string;
  consecutiveFailures: number;
  health: "healthy" | "degraded";
  checkpoint?: SourceCheckpoint;
  lastError?: string;
}
