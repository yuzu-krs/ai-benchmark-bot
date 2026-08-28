import { anthropicSource } from "./anthropic.js";
import { deepSeekSource } from "./deepseek.js";
import { googleSource } from "./google.js";
import { mistralSource } from "./mistral.js";
import { openAiSource } from "./openai.js";
import { xaiSource } from "./xai.js";
import { zaiSource } from "./zai.js";
import type { ProviderSource } from "./common.js";

export { fetchAnnouncementItems } from "./common.js";
export type { ProviderSource } from "./common.js";
export type {
  AnnouncementItem,
  AnnouncementConfidence,
  RawAnnouncement
} from "./classification.js";

/** Providers polled for new-model announcements, in notification order. */
export const PROVIDER_SOURCES: readonly ProviderSource[] = [
  openAiSource,
  anthropicSource,
  googleSource,
  mistralSource,
  xaiSource,
  deepSeekSource,
  zaiSource
];
