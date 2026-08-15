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

export interface NewModelAnnouncement {
  providerId: string;
  providerName: string;
  title: string;
  url: string;
  summary?: string;
  modelIds: string[];
  stage: ReleaseStage;
  publishedAt?: string;
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
