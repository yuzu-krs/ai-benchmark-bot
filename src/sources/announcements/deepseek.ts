import * as cheerio from "cheerio";
import {
  absoluteUrl,
  cleanText,
  toIsoDate,
  type RawAnnouncement
} from "../announcement-utils.js";
import { AnnouncementSourceAdapter } from "./common.js";

const SOURCE_URL = "https://api-docs.deepseek.com/updates";

export function parseDeepSeekHtml(html: string): RawAnnouncement[] {
  const $ = cheerio.load(html);
  const headings = $("h3").toArray();
  if (headings.length === 0) throw new Error("DeepSeek change-log entries were not found");

  const items: RawAnnouncement[] = [];
  for (const heading of headings) {
    const title = cleanText($(heading).clone().find("a").remove().end().text(), 180);
    if (!title) continue;
    const dateHeading = $(heading).prevAll("h2").first();
    const dateText = cleanText(dateHeading.text().replace(/^Date:\s*/i, ""), 80);
    const publishedAt = toIsoDate(dateText);
    const fragments: string[] = [];
    let sibling = $(heading).next();
    while (sibling.length > 0 && !sibling.is("h2,h3")) {
      fragments.push($.html(sibling));
      sibling = sibling.next();
    }
    const fragmentHtml = fragments.join("\n");
    const fragment = cheerio.load(fragmentHtml);
    const summary = cleanText(fragment.root().text(), 600);
    const preferredHref =
      fragment('a[href*="/news/"]').first().attr("href") ??
      fragment("a[href]").first().attr("href");
    const headingId = $(heading).attr("id") ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    items.push({
      key: `${dateText}/${headingId}`,
      title,
      url: preferredHref
        ? absoluteUrl(preferredHref, SOURCE_URL)
        : `${SOURCE_URL}#${headingId}`,
      ...(publishedAt ? { publishedAt } : {}),
      ...(summary ? { summary } : {}),
      modelIdHints: fragment("code")
        .toArray()
        .map((code) => fragment(code).text().trim())
        .filter(Boolean)
    });
  }
  if (items.length === 0) throw new Error("DeepSeek change-log entries were empty");
  return items;
}

export function createDeepSeekAdapter(): AnnouncementSourceAdapter {
  return new AnnouncementSourceAdapter({
    id: "deepseek",
    displayName: "DeepSeek change log",
    providerName: "DeepSeek",
    sourceUrl: SOURCE_URL,
    accept: "text/html, application/xhtml+xml;q=0.9",
    parser: (body) => parseDeepSeekHtml(body)
  });
}
