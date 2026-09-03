export type ReleaseStage =
  | "preview"
  | "general_availability"
  | "open_weights"
  | "research_preview"
  | "unknown";

export interface RankedModel {
  entityKey: string;
  name: string;
  organization?: string;
  rank: number;
  score: number;
  scoreDisplay: string;
}

export interface RankingSnapshot {
  savedAt: string;
  entries: RankedModel[];
}

/** Upstream a ranking board is fetched from. */
export type RankingSourceId = "lmarena" | "aa";

/**
 * Source-qualified board key. Also the state-file name (`<board>.json`), so
 * existing values must never change once released; source-side identifiers
 * live in the per-source registries.
 */
export type RankingBoard =
  | "lmarena-overall"
  | "lmarena-coding"
  | "aa-intelligence"
  | "aa-coding";

/** Source-provided context rendered into the daily embed. */
export interface RankingEmbedMeta {
  /** AA terms of use require a visible attribution; the version is optional. */
  aa?: { intelligenceIndexVersion?: string; attributionUrl: string };
}

export interface SeenModel {
  key: string;
  providerId: string;
  modelId: string;
  firstSeenAt: string;
}

/** Display-ready pricing resolved from OpenRouter for one model. */
export interface ModelPrice {
  /** "$1.2/$12" per 1M tokens, or "無料" / "変動制". */
  priceDisplay: string;
  /** "200K" / "1M"; omitted when unknown. */
  contextDisplay?: string;
}

export interface NewModelAnnouncement {
  providerId: string;
  providerName: string;
  title: string;
  url: string;
  summary?: string;
  modelIds: string[];
  stage: ReleaseStage;
  publishedAt?: string;
  /** Keyed by the exact strings in `modelIds`; present only for matched models. */
  pricingByModel?: Record<string, ModelPrice>;
  detectedAt: string;
}

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/** Plain Discord embed payload; kept structural so builders stay testable without discord.js. */
export interface EmbedPayload {
  title: string;
  description?: string;
  color?: number;
  fields: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
}
