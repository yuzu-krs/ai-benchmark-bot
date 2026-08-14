import {
  cleanText,
  recognizedModelIds,
  toIsoDate,
  type RawAnnouncement
} from "../announcement-utils.js";
import { AnnouncementSourceAdapter } from "./common.js";
import { markdownLinks, stripMarkdown } from "./parsing.js";

const SOURCE_URL = "https://docs.z.ai/release-notes/new-released";
const FETCH_URL = `${SOURCE_URL}.md`;

const UPDATE_OPEN_PATTERN = /<Update\b/gi;
const UPDATE_CLOSE_PATTERN = /<\/Update\s*>/gi;
const UPDATE_BLOCK_PATTERN = /<Update\b(?<attributes>[^>]*)>(?<body>[\s\S]*?)<\/Update\s*>/gi;
const ATTRIBUTE_PATTERN = /\b(?<name>[A-Za-z][A-Za-z0-9_-]*)\s*=\s*"(?<value>[^"]*)"/g;

export function parseZaiReleaseNotes(markdown: string): RawAnnouncement[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!/^# New Released\s*$/m.test(normalized) || !/^## Models\s*$/m.test(normalized)) {
    throw new Error("Z.ai release-note headings were not found");
  }
  const modelsSection = extractModelsSection(normalized);

  const openingCount = [...modelsSection.matchAll(UPDATE_OPEN_PATTERN)].length;
  const closingCount = [...modelsSection.matchAll(UPDATE_CLOSE_PATTERN)].length;
  const blocks = [...modelsSection.matchAll(UPDATE_BLOCK_PATTERN)];
  if (openingCount === 0) throw new Error("Z.ai release-note entries were not found");
  if (openingCount !== closingCount || blocks.length !== openingCount) {
    throw new Error("Z.ai release-note Update structure is malformed");
  }

  const seenKeys = new Set<string>();
  return blocks.map((block, index) => {
    const attributes = parseUpdateAttributes(block.groups?.attributes ?? "", index);
    const date = attributes.get("label");
    const description = attributes.get("description");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Z.ai release-note entry ${index + 1} has an invalid label`);
    }
    if (!description) {
      throw new Error(`Z.ai release-note entry ${index + 1} has no description`);
    }

    const publishedAt = toIsoDate(date);
    if (!publishedAt || !publishedAt.startsWith(`${date}T`)) {
      throw new Error(`Z.ai release-note entry ${index + 1} has an invalid date`);
    }
    const title = cleanText(description, 180);
    if (!title) throw new Error(`Z.ai release-note entry ${index + 1} has an empty title`);

    const body = block.groups?.body?.trim() ?? "";
    if (!body) throw new Error(`Z.ai release-note entry ${index + 1} has an empty body`);
    // The title is the source's model identifier. Keeping the key independent
    // of the date avoids a duplicate notification if the publisher corrects a
    // date or moves the entry without introducing a different model.
    const key = `model:${recognizedModelIds([title])[0] ?? slug(title)}`;
    if (seenKeys.has(key)) throw new Error(`Z.ai release-note entry key is duplicated: ${key}`);
    seenKeys.add(key);

    const officialUrl = markdownLinks(body, SOURCE_URL).find(isOfficialZaiUrl) ?? SOURCE_URL;
    const releaseSummary = stripMarkdown(body, 520);
    const summary = cleanText(
      `Z.ai officially released ${title}.${releaseSummary ? ` ${releaseSummary}` : ""}`,
      600
    );

    const explicitModelIds = isModelIdentifier(title) ? [title] : [];
    return {
      key,
      title,
      url: officialUrl,
      publishedAt,
      summary,
      modelIdHints: [title],
      ...(explicitModelIds.length > 0 ? { explicitModelIds } : {}),
      officialModelEntry: true,
      authoritativeModelIds: true
    };
  });
}

function extractModelsSection(markdown: string): string {
  const lines = markdown.split("\n");
  const modelHeadings = lines
    .map((line, index) => (/^## Models\s*$/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (modelHeadings.length !== 1) {
    throw new Error("Z.ai release-note Models heading is missing or duplicated");
  }
  const start = (modelHeadings[0] ?? -1) + 1;
  const nextLevelTwo = lines.findIndex((line, index) => index >= start && /^##\s+/.test(line));
  const end = nextLevelTwo >= 0 ? nextLevelTwo : lines.length;
  return lines.slice(start, end).join("\n");
}

function isModelIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9_.]*(?:[-:][a-z0-9_.]+)+(?:\/[a-z0-9_.:-]+)?$/i.test(value);
}

export function createZaiAdapter(): AnnouncementSourceAdapter {
  return new AnnouncementSourceAdapter({
    id: "zai",
    displayName: "Z.ai model release notes",
    providerName: "Z.ai",
    sourceUrl: SOURCE_URL,
    fetchUrl: FETCH_URL,
    accept: "text/markdown, text/plain;q=0.9",
    parser: (body) => parseZaiReleaseNotes(body)
  });
}

function parseUpdateAttributes(raw: string, index: number): Map<string, string> {
  const attributes = new Map<string, string>();
  let remainder = raw;
  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    const fullMatch = match[0];
    const name = match.groups?.name;
    const value = match.groups?.value;
    if (!fullMatch || !name || value === undefined) continue;
    if (attributes.has(name)) {
      throw new Error(`Z.ai release-note entry ${index + 1} repeats attribute ${name}`);
    }
    attributes.set(name, cleanText(value, 240));
    remainder = remainder.replace(fullMatch, " ");
  }
  if (remainder.trim()) {
    throw new Error(`Z.ai release-note entry ${index + 1} has unsupported attributes`);
  }
  if ([...attributes.keys()].some((name) => name !== "label" && name !== "description")) {
    throw new Error(`Z.ai release-note entry ${index + 1} has unsupported attributes`);
  }
  return attributes;
}

function isOfficialZaiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && (url.hostname === "docs.z.ai" || url.hostname === "z.ai")
    );
  } catch {
    return false;
  }
}

function slug(value: string): string {
  const slugged = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slugged) throw new Error("Z.ai release-note title cannot form a stable key");
  return slugged;
}
