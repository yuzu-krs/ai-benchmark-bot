import { z } from "zod";
import {
  cleanText,
  toIsoDate,
  type RawAnnouncement
} from "../announcement-utils.js";
import { parseJson } from "../http.js";
import { AnnouncementSourceAdapter } from "./common.js";

const SOURCE_URL = "https://qwen.ai/research";
const API_URL = "https://qwen.ai/api/page_config?code=research.research-list";

const pageItemSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    date: z.string().trim().min(1),
    description: z.string().optional(),
    introduction: z.string().optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    draft: z.boolean().optional(),
    htmlLink: z.string().url().optional(),
    tokenLinks: z.string().url().optional()
  })
  .passthrough();

const pageSchema = z.array(pageItemSchema).min(1);

export function parseQwenPageConfig(json: string): RawAnnouncement[] {
  const parsed = pageSchema.parse(parseJson(json, "Qwen page_config"));
  return parsed
    .filter((entry) => entry.draft !== true)
    .map((entry) => {
      const publishedAt = toIsoDate(entry.date);
      if (!publishedAt) throw new Error(`Qwen entry ${entry.id} has an invalid date`);
      const prose = entry.description ?? entry.summary ?? entry.introduction ?? entry.title;
      const tags = entry.tags?.join(", ");
      return {
        key: entry.id,
        title: entry.title,
        url: `${SOURCE_URL}/${encodeURIComponent(entry.id)}`,
        publishedAt,
        summary: cleanText(`${prose}${tags ? ` Tags: ${tags}` : ""}`, 600),
        modelIdHints: [entry.id]
      };
    });
}

export function createQwenAdapter(): AnnouncementSourceAdapter {
  return new AnnouncementSourceAdapter({
    id: "qwen",
    displayName: "Qwen Research (staged)",
    providerName: "Qwen",
    sourceUrl: SOURCE_URL,
    fetchUrl: API_URL,
    accept: "application/json",
    parser: (body) => parseQwenPageConfig(body)
  });
}
