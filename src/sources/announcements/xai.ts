import type { RawAnnouncement } from "../announcement-utils.js";
import { AnnouncementSourceAdapter } from "./common.js";
import {
  markdownCodeValues,
  markdownLinks,
  markdownSections,
  stripMarkdown
} from "./parsing.js";

const SOURCE_URL = "https://docs.x.ai/developers/release-notes";
const FETCH_URL = `${SOURCE_URL}.md`;

export function parseXaiMarkdown(markdown: string): RawAnnouncement[] {
  const sections = markdownSections(markdown, 3).filter(
    (section) => section.heading.toLowerCase() !== "release notes" && section.body.length > 0
  );
  if (sections.length === 0) throw new Error("xAI release-note entries were not found");

  return sections.map((section) => {
    const links = markdownLinks(section.body, SOURCE_URL);
    const announcementLink = links.find((link) => {
      const url = new URL(link);
      return url.hostname === "x.ai" && url.pathname.startsWith("/news/");
    });
    return {
      key: `${section.parentHeading ?? ""}/${section.heading}`,
      title: section.heading,
      url: announcementLink ?? links[0] ?? SOURCE_URL,
      summary: stripMarkdown(section.body, 600),
      modelIdHints: markdownCodeValues(section.body)
    };
  });
}

export function createXaiAdapter(): AnnouncementSourceAdapter {
  return new AnnouncementSourceAdapter({
    id: "xai",
    displayName: "xAI release notes",
    providerName: "xAI",
    sourceUrl: SOURCE_URL,
    fetchUrl: FETCH_URL,
    // docs.x.ai currently selects the Markdown representation by the .md
    // suffix and returns 404 when a text/markdown Accept header is present.
    accept: "*/*",
    parser: (body) => parseXaiMarkdown(body)
  });
}
