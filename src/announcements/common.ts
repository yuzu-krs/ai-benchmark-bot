import { fetchText } from "../http.js";
import {
  buildAnnouncementItems,
  type AnnouncementItem,
  type RawAnnouncement
} from "./classification.js";

export interface ProviderSource {
  readonly id: string;
  readonly providerName: string;
  readonly displayName: string;
  readonly fetchUrl: string;
  readonly accept: string;
  readonly maxBytes?: number;
  parse(body: string): RawAnnouncement[];
}

export interface FetchAnnouncementsOptions {
  fetchFn?: typeof globalThis.fetch;
}

/** Fetches one provider's announcement document and classifies its entries. */
export async function fetchAnnouncementItems(
  source: ProviderSource,
  options: FetchAnnouncementsOptions = {}
): Promise<AnnouncementItem[]> {
  const { text } = await fetchText(source.fetchUrl, {
    headers: { accept: source.accept },
    maxBytes: source.maxBytes ?? 8 * 1024 * 1024,
    fetchFn: options.fetchFn
  });
  const rawItems = source.parse(text);
  if (rawItems.length === 0) {
    throw new Error(`${source.displayName} parser found no source entries`);
  }
  return buildAnnouncementItems(source.id, rawItems);
}
