import { PROVIDER_SOURCES, fetchAnnouncementItems, type ProviderSource } from "./announcements/index.js";
import { buildNewModelEmbed } from "./embeds.js";
import { errorFields, type Logger } from "./logger.js";
import type { StateStore } from "./state.js";
import type { EmbedPayload, NewModelAnnouncement, SeenModel } from "./types.js";

export function seenModelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export interface AlertsDeps {
  timeZone: string;
  store: StateStore;
  logger: Logger;
  send(embed: EmbedPayload): Promise<void>;
  sources?: readonly ProviderSource[];
  fetchFn?: typeof globalThis.fetch;
  now?: () => Date;
}

/**
 * Polls every provider once, notifies new confirmed model announcements, and
 * records notified models in seen-models.json. The very first poll only
 * establishes a baseline so historical entries are not announced.
 */
export async function pollNewModelAlerts(deps: AlertsDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const sources = deps.sources ?? PROVIDER_SOURCES;
  const results = await Promise.allSettled(
    sources.map((source) => fetchAnnouncementItems(source, { fetchFn: deps.fetchFn }))
  );

  const baseline = !deps.store.hasSeenModels();
  const seen = baseline ? [] : deps.store.loadSeenModels();
  const seenKeys = new Set(seen.map((model) => model.key));
  const additions: SeenModel[] = [];

  let notified = 0;
  for (const [index, result] of results.entries()) {
    const source = sources[index];
    if (!source) continue;
    if (result.status === "rejected") {
      deps.logger.error("provider poll failed", {
        provider: source.id,
        ...errorFields(result.reason)
      });
      continue;
    }
    const confirmed = result.value.filter(
      (item) => item.confidence === "confirmed" && item.modelIds.length > 0
    );
    if (baseline) {
      for (const item of confirmed) {
        for (const modelId of item.modelIds) {
          recordSeen(additions, seenKeys, source.id, modelId, now);
        }
      }
      continue;
    }
    for (const item of confirmed) {
      const freshModels = item.modelIds.filter(
        (modelId) => !seenKeys.has(seenModelKey(source.id, modelId))
      );
      if (freshModels.length === 0) continue;
      const alert: NewModelAnnouncement = {
        providerId: source.id,
        providerName: source.providerName,
        title: item.title,
        url: item.url,
        ...(item.summary ? { summary: item.summary } : {}),
        modelIds: freshModels,
        stage: item.stage,
        ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        detectedAt: now.toISOString()
      };
      try {
        await deps.send(buildNewModelEmbed(alert, deps.timeZone));
      } catch (error) {
        // Leave the models unseen so the next poll retries this alert.
        deps.logger.error("new model alert send failed", {
          provider: source.id,
          models: freshModels,
          ...errorFields(error)
        });
        continue;
      }
      notified += 1;
      for (const modelId of freshModels) {
        recordSeen(additions, seenKeys, source.id, modelId, now);
      }
      deps.logger.info("new model alert sent", { provider: source.id, models: freshModels });
    }
  }

  if (baseline) {
    deps.store.saveSeenModels(additions);
    deps.logger.info("provider baseline established", { models: additions.length });
  } else if (additions.length > 0) {
    deps.store.saveSeenModels([...seen, ...additions]);
  }
  return notified;
}

function recordSeen(
  additions: SeenModel[],
  seenKeys: Set<string>,
  providerId: string,
  modelId: string,
  now: Date
): void {
  const key = seenModelKey(providerId, modelId);
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  additions.push({ key, providerId, modelId, firstSeenAt: now.toISOString() });
}
