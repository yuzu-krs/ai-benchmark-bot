import type { RawAnnouncement } from "./classification.js";
import type { ProviderSource } from "./common.js";
import { parseRssAnnouncements } from "./parsing.js";

const FEED_URL = "https://platform.claude.com/docs/en/release-notes/feed.xml";
const SOURCE_URL = "https://platform.claude.com/docs/en/release-notes/overview";

export function parseAnthropicRss(xml: string): RawAnnouncement[] {
  return parseRssAnnouncements(xml, SOURCE_URL, { splitDescriptionListItems: true });
}

export const anthropicSource: ProviderSource = {
  id: "anthropic",
  providerName: "Anthropic",
  displayName: "Anthropic release notes",
  fetchUrl: FEED_URL,
  accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
  parse: parseAnthropicRss
};
