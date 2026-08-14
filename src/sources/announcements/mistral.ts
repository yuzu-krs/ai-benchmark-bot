import type { RawAnnouncement } from "../announcement-utils.js";
import { AnnouncementSourceAdapter } from "./common.js";
import { parseRssAnnouncements } from "./parsing.js";

const FEED_URL = "https://mistral.ai/news/rss";
const SOURCE_URL = "https://mistral.ai/news";

export function parseMistralRss(xml: string): RawAnnouncement[] {
  return parseRssAnnouncements(xml, SOURCE_URL);
}

export function createMistralAdapter(): AnnouncementSourceAdapter {
  return new AnnouncementSourceAdapter({
    id: "mistral",
    displayName: "Mistral AI News",
    providerName: "Mistral AI",
    sourceUrl: SOURCE_URL,
    fetchUrl: FEED_URL,
    accept: "application/rss+xml, application/xml;q=0.9, text/plain;q=0.8",
    parser: (body) => parseMistralRss(body)
  });
}
