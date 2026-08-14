import * as cheerio from "cheerio";
import {
  absoluteUrl,
  cleanText,
  toIsoDate,
  type RawAnnouncement
} from "../announcement-utils.js";
import { AnnouncementSourceAdapter } from "./common.js";

const SOURCE_URL = "https://ai.meta.com/blog/";
const DATE_PATTERN =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+20\d{2}\b/i;

export function parseMetaBlogHtml(html: string): RawAnnouncement[] {
  const $ = cheerio.load(html);
  const byUrl = new Map<string, RawAnnouncement>();

  $("a[href]").each((_index, element) => {
    const node = $(element);
    const href = node.attr("href");
    if (!href) return;
    let url: string;
    try {
      url = absoluteUrl(href, SOURCE_URL);
    } catch {
      return;
    }
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname !== "ai.meta.com" || !/^\/blog\/[^/]+\/?$/.test(parsedUrl.pathname)) {
      return;
    }

    const ariaTitle = node.attr("aria-label")?.replace(/^Read\s+/i, "");
    const title = cleanText(ariaTitle || node.text(), 180);
    if (title.length < 8 || /^(?:featured|read more|learn more)$/i.test(title)) return;

    let cardText = "";
    let dateText: string | undefined;
    for (const ancestor of node.parents().toArray().slice(0, 5)) {
      const candidate = cleanText($(ancestor).text(), 800);
      const dateMatch = DATE_PATTERN.exec(candidate);
      if (dateMatch) {
        cardText = candidate;
        dateText = dateMatch[0];
        break;
      }
    }
    const publishedAt = dateText ? toIsoDate(dateText) : undefined;
    byUrl.set(url, {
      key: parsedUrl.pathname,
      title,
      url,
      ...(publishedAt ? { publishedAt } : {}),
      summary: cardText || title
    });
  });

  const items = [...byUrl.values()];
  if (items.length === 0) {
    throw new Error("Meta AI blog card structure was not recognized");
  }
  return items;
}

export function createMetaAdapter(): AnnouncementSourceAdapter {
  return new AnnouncementSourceAdapter({
    id: "meta",
    displayName: "Meta AI Blog (staged)",
    providerName: "Meta",
    sourceUrl: SOURCE_URL,
    accept: "text/html, application/xhtml+xml;q=0.9",
    parser: (body) => parseMetaBlogHtml(body)
  });
}
