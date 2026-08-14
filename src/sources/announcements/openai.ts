import { toIsoDate, type RawAnnouncement } from "../announcement-utils.js";
import { AnnouncementSourceAdapter } from "./common.js";
import {
  markdownCodeValues,
  markdownSections,
  stripMarkdown
} from "./parsing.js";

const SOURCE_URL = "https://developers.openai.com/api/docs/changelog";
const FETCH_URL = `${SOURCE_URL}.md`;

export function parseOpenAiMarkdown(markdown: string): RawAnnouncement[] {
  const sections = markdownSections(markdown, 3).filter((section) =>
    /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}$/i.test(
      section.heading
    )
  );
  if (sections.length === 0) throw new Error("OpenAI changelog date sections were not found");

  return sections.flatMap((section) => {
    const explicitModels = [
      ...new Set(
        [...section.body.matchAll(/\bModel:\s*([a-z0-9][a-z0-9._:-]*)/gi)]
          .map((match) => match[1]?.replace(/[.:_-]+$/, "").toLowerCase())
          .filter((value): value is string => Boolean(value))
      )
    ];
    const bodyWithoutMetadata = section.body.replace(
      /^\s*(?:Feature|Update|Announcement|Deprecation)(?:\s*·[^\n]*)?\s*/i,
      ""
    );
    const year = /\b(20\d{2})\b/.exec(section.parentHeading ?? "")?.[1];
    const publishedAt = year ? toIsoDate(`${section.heading}, ${year} UTC`) : undefined;
    const anchor = slug(section.parentHeading ?? "changelog");
    const common = {
      url: `${SOURCE_URL}#${anchor}`,
      ...(publishedAt ? { publishedAt } : {}),
      summary: stripMarkdown(bodyWithoutMetadata, 600),
      modelIdHints: markdownCodeValues(section.body)
    };
    if (explicitModels.length === 0) {
      return [
        {
          key: `${section.parentHeading ?? ""}/${section.heading}/general`,
          title: `OpenAI API update — ${section.heading}`,
          ...common
        }
      ];
    }
    return explicitModels.map((modelId) => ({
      key: `${section.parentHeading ?? ""}/${section.heading}/model:${modelId}`,
      title: `OpenAI API entry: ${modelId} — ${section.heading}`,
      ...common,
      explicitModelIds: [modelId]
    }));
  });
}

export function createOpenAiAdapter(): AnnouncementSourceAdapter {
  return new AnnouncementSourceAdapter({
    id: "openai",
    displayName: "OpenAI API changelog",
    providerName: "OpenAI",
    sourceUrl: SOURCE_URL,
    fetchUrl: FETCH_URL,
    accept: "text/markdown, text/plain;q=0.9",
    parser: (body) => parseOpenAiMarkdown(body)
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
