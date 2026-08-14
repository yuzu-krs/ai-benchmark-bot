import type { RawAnnouncement } from "../announcement-utils.js";
import { AnnouncementSourceAdapter } from "./common.js";
import { parseRssAnnouncements } from "./parsing.js";

const FEED_URL = "https://platform.claude.com/docs/en/release-notes/feed.xml";
const SOURCE_URL = "https://platform.claude.com/docs/en/release-notes/overview";

export function parseAnthropicRss(xml: string): RawAnnouncement[] {
  return parseRssAnnouncements(xml, SOURCE_URL, { splitDescriptionListItems: true });
}

export function createAnthropicAdapter(): AnnouncementSourceAdapter {
  return new AnnouncementSourceAdapter({
    id: "anthropic",
    displayName: "Anthropic release notes",
    providerName: "Anthropic",
    sourceUrl: SOURCE_URL,
    fetchUrl: FEED_URL,
    accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
    parser: (body) => parseAnthropicRss(body)
  });
}
