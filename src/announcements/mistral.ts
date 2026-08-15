import type { RawAnnouncement } from "./classification.js";
import type { ProviderSource } from "./common.js";
import { parseRssAnnouncements } from "./parsing.js";

const FEED_URL = "https://mistral.ai/news/rss";
const SOURCE_URL = "https://mistral.ai/news";

export function parseMistralRss(xml: string): RawAnnouncement[] {
  return parseRssAnnouncements(xml, SOURCE_URL);
}

export const mistralSource: ProviderSource = {
  id: "mistral",
  providerName: "Mistral AI",
  displayName: "Mistral AI News",
  fetchUrl: FEED_URL,
  accept: "application/rss+xml, application/xml;q=0.9, text/plain;q=0.8",
  parse: parseMistralRss
};
