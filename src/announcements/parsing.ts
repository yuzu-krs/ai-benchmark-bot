import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { sha256 } from "../hash.js";
import {
  absoluteUrl,
  cleanText,
  recognizedModelIds,
  toIsoDate,
  type RawAnnouncement
} from "./classification.js";

export interface MarkdownSection {
  heading: string;
  parentHeading?: string;
  body: string;
}

export function markdownSections(markdown: string, level: number): MarkdownSection[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const sections: MarkdownSection[] = [];
  let parentHeading: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!headingMatch) continue;
    const currentLevel = headingMatch[1]?.length ?? 0;
    const heading = headingMatch[2]?.trim() ?? "";
    if (currentLevel < level) parentHeading = heading;
    if (currentLevel !== level) continue;

    const bodyLines: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? "";
      const nextHeading = /^(#{1,6})\s+/.exec(candidate);
      if (nextHeading && (nextHeading[1]?.length ?? 7) <= level) break;
      bodyLines.push(candidate);
    }
    sections.push({
      heading,
      ...(parentHeading ? { parentHeading } : {}),
      body: bodyLines.join("\n").trim()
    });
  }
  return sections;
}

export function stripMarkdown(markdown: string, maxLength = 500): string {
  return cleanText(
    markdown
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_>#~|-]/g, " ")
      .replace(/<[^>]+>/g, " "),
    maxLength
  );
}

export function markdownLinks(markdown: string, baseUrl: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (!href) continue;
    try {
      links.push(absoluteUrl(href, baseUrl));
    } catch {
      // A malformed link should not invalidate an otherwise valid source entry.
    }
  }
  return links;
}

export function markdownCodeValues(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

const rssItemSchema = z
  .object({
    title: z.string().trim().min(1),
    link: z.string().trim().min(1),
    guid: z
      .union([
        z.string(),
        z.object({ "#text": z.string() }).passthrough()
      ])
      .optional(),
    pubDate: z.string().optional(),
    description: z.string().optional()
  })
  .passthrough();

const rssSchema = z
  .object({
    rss: z
      .object({
        channel: z
          .object({
            item: z.union([rssItemSchema, z.array(rssItemSchema)])
          })
          .passthrough()
      })
      .passthrough()
  })
  .passthrough();

export function parseRssAnnouncements(
  xml: string,
  baseUrl: string,
  options: { splitDescriptionListItems?: boolean } = {}
): RawAnnouncement[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    processEntities: true
  });
  let payload: unknown;
  try {
    payload = parser.parse(xml) as unknown;
  } catch (error) {
    throw new Error("Announcement feed returned invalid XML", { cause: error });
  }
  const parsed = rssSchema.parse(payload);
  const feedItems = Array.isArray(parsed.rss.channel.item)
    ? parsed.rss.channel.item
    : [parsed.rss.channel.item];
  if (feedItems.length === 0) throw new Error("Announcement RSS feed is empty");

  const output: RawAnnouncement[] = [];
  for (const item of feedItems) {
    const guid =
      typeof item.guid === "string" ? item.guid : item.guid?.["#text"] ?? item.link;
    const publishedAt = item.pubDate ? toIsoDate(item.pubDate) : undefined;
    const description = item.description ?? "";
    const $ = cheerio.load(description);
    const listEntries = options.splitDescriptionListItems
      ? $("li")
          .toArray()
          .filter((element) => $(element).parents("li").length === 0)
      : [];

    if (listEntries.length > 0) {
      listEntries.forEach((element) => {
        const node = $(element);
        const summary = cleanText(node.text(), 600);
        if (!summary) return;
        const codeValues = node
          .find("code")
          .toArray()
          .map((code) => $(code).text().trim())
          .filter(Boolean);
        const stableModelIds = recognizedModelIds(codeValues);
        output.push({
          // Feed publishers commonly prepend or reorder list items within the
          // same GUID. A normalized content digest keeps unaffected entries
          // stable without relying on their array position.
          key:
            stableModelIds.length > 0
              ? `${guid}#models:${stableModelIds.sort().join(",")}`
              : `${guid}#${sha256(summary)}`,
          title: cleanText(summary, 140),
          url: absoluteUrl(item.link, baseUrl),
          ...(publishedAt ? { publishedAt } : {}),
          summary,
          modelIdHints: codeValues
        });
      });
      continue;
    }

    const summary = cleanText($.root().text() || description, 600);
    output.push({
      key: guid,
      title: item.title,
      url: absoluteUrl(item.link, baseUrl),
      ...(publishedAt ? { publishedAt } : {}),
      ...(summary ? { summary } : {}),
      modelIdHints: $("code")
        .toArray()
        .map((code) => $(code).text().trim())
        .filter(Boolean)
    });
  }
  return output;
}
