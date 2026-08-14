import type {
  AnnouncementSnapshot,
  SourceAdapter,
  SourceAdapterContext,
  SourceId
} from "../../domain/models.js";
import {
  buildAnnouncementItems,
  type RawAnnouncement
} from "../announcement-utils.js";
import { fetchResource } from "../http.js";

export type AnnouncementParser = (body: string, now: Date) => RawAnnouncement[];

export interface AnnouncementAdapterOptions {
  id: Exclude<SourceId, "lmarena" | "swebench">;
  displayName: string;
  providerName: string;
  sourceUrl: string;
  fetchUrl?: string;
  accept: string;
  parser: AnnouncementParser;
  maxBytes?: number;
}

export class AnnouncementSourceAdapter implements SourceAdapter {
  readonly id: AnnouncementAdapterOptions["id"];
  readonly displayName: string;
  readonly intervalMinutes = 60;
  readonly targets: readonly string[];

  constructor(private readonly options: AnnouncementAdapterOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.targets = [`provider-${options.id}`];
  }

  async poll(context: SourceAdapterContext): Promise<AnnouncementSnapshot[]> {
    const response = await fetchResource(
      context.fetch,
      this.options.fetchUrl ?? this.options.sourceUrl,
      {
        checkpoint: context.checkpoint,
        headers: { accept: this.options.accept },
        maxBytes: this.options.maxBytes ?? 8 * 1024 * 1024
      }
    );
    if (response.status === "not_modified") return [];
    if (response.checkpoint.contentHash === context.checkpoint?.contentHash) return [];

    const rawItems = this.options.parser(response.text, context.now);
    if (rawItems.length === 0) {
      throw new Error(`${this.options.displayName} parser found no source entries`);
    }
    const items = buildAnnouncementItems(this.id, rawItems);
    const revision = rawItems
      .map((item) => item.publishedAt ?? item.key)
      .sort()
      .at(-1);
    const checkpoint = { ...response.checkpoint };
    if (revision) checkpoint.revision = revision;

    return [
      {
        kind: "announcements",
        sourceId: this.id,
        providerName: this.options.providerName,
        sourceUrl: this.options.sourceUrl,
        observedAt: context.now.toISOString(),
        items,
        checkpoint
      }
    ];
  }
}
