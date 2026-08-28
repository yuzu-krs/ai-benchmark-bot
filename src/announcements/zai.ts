import * as cheerio from "cheerio";
import { absoluteUrl, cleanText, toIsoDate, type RawAnnouncement } from "./classification.js";
import type { ProviderSource } from "./common.js";

const SOURCE_URL = "https://docs.z.ai/release-notes";

/**
 * Parses Z.ai's Mintlify release notes. Each entry renders as a
 * `div.update[id=<date>]` container holding a date label button, the model
 * name as the "update description", and the release bullets as the
 * "update content" — verified against the live page markup.
 */
export function parseZaiHtml(html: string): RawAnnouncement[] {
  const $ = cheerio.load(html);
  const entries = $("div.update[id]").toArray();
  if (entries.length === 0) throw new Error("Z.ai release-note entries were not found");

  const items: RawAnnouncement[] = [];
  for (const entry of entries) {
    const container = $(entry);
    const headingId = cleanText(container.attr("id") ?? "", 120);
    const dateLabel = cleanText(
      container.find('[data-component-part="update-label"]').first().text(),
      80
    );
    const title = cleanText(
      container.find('[data-component-part="update-description"]').first().text(),
      180
    );
    if (!title) continue;
    const content = container.find('[data-component-part="update-content"]').first();
    const summary = cleanText(content.text(), 600);
    const preferredHref = content.find("a[href]").first().attr("href");
    const dateText = dateLabel || headingId;
    const publishedAt = toIsoDate(dateText);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    items.push({
      key: `${dateText || "undated"}/${slug}`,
      title,
      url: preferredHref
        ? absoluteUrl(preferredHref, SOURCE_URL)
        : `${SOURCE_URL}#${headingId}`,
      ...(publishedAt ? { publishedAt } : {}),
      ...(summary ? { summary } : {}),
      // Z.ai's own release notes name the model in every entry title, so a
      // recognized model family there is an official model announcement.
      officialModelEntry: true,
      modelIdHints: [
        title,
        ...content
          .find("code")
          .toArray()
          .map((code) => $(code).text().trim())
          .filter(Boolean)
      ]
    });
  }
  if (items.length === 0) throw new Error("Z.ai release-note entries were empty");
  return items;
}

export const zaiSource: ProviderSource = {
  id: "zai",
  providerName: "Z.ai",
  displayName: "Z.ai release notes",
  fetchUrl: SOURCE_URL,
  accept: "text/html, application/xhtml+xml;q=0.9",
  parse: parseZaiHtml
};
