import * as cheerio from "cheerio";
import {
  absoluteUrl,
  cleanText,
  toIsoDate,
  type RawAnnouncement
} from "../announcement-utils.js";
import { AnnouncementSourceAdapter } from "./common.js";

const SOURCE_URL = "https://ai.google.dev/gemini-api/docs/changelog";
const FETCH_URL = `${SOURCE_URL}?hl=en`;

export function parseGoogleChangelogHtml(html: string): RawAnnouncement[] {
  const $ = cheerio.load(html);
  const dateHeadings = $("h2")
    .toArray()
    .filter((heading) => toIsoDate($(heading).text()) !== undefined);
  if (dateHeadings.length === 0) throw new Error("Google Gemini changelog headings were not found");

  const items: RawAnnouncement[] = [];
  for (const heading of dateHeadings) {
    const dateText = cleanText($(heading).text(), 80);
    const publishedAt = toIsoDate(dateText);
    let sibling = $(heading).next();
    let entryIndex = 0;
    while (sibling.length > 0 && !sibling.is("h2")) {
      if (sibling.is("ul,ol")) {
        sibling.children("li").each((_index, element) => {
          const node = $(element);
          const summary = cleanText(node.text(), 600);
          if (!summary) return;
          const strongTitle = cleanText(node.find("strong").first().text(), 180);
          const title = strongTitle || cleanText(summary.split(/[.!?](?:\s|$)/)[0] ?? summary, 180);
          const href =
            node.find('a[href*="/models/"]').first().attr("href") ??
            node.find("a[href]").first().attr("href");
          const modelIdHints = node
            .find("code")
            .toArray()
            .map((code) => $(code).text().trim())
            .filter(Boolean);
          const entryIdentity = modelIdHints.join("|") || href || title || String(entryIndex);
          items.push({
            key: `${$(heading).attr("id") ?? dateText}/${entryIdentity}`,
            title,
            url: href
              ? absoluteUrl(href, SOURCE_URL)
              : `${SOURCE_URL}#${$(heading).attr("id") ?? "changelog"}`,
            ...(publishedAt ? { publishedAt } : {}),
            summary,
            modelIdHints
          });
          entryIndex += 1;
        });
      }
      sibling = sibling.next();
    }
  }
  if (items.length === 0) throw new Error("Google Gemini changelog entries were not found");
  return items;
}

export function createGoogleAdapter(): AnnouncementSourceAdapter {
  return new AnnouncementSourceAdapter({
    id: "google",
    displayName: "Google Gemini API changelog",
    providerName: "Google",
    sourceUrl: SOURCE_URL,
    fetchUrl: FETCH_URL,
    accept: "text/html, application/xhtml+xml;q=0.9",
    parser: (body) => parseGoogleChangelogHtml(body)
  });
}
