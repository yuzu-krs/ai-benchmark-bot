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
