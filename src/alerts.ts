import { PROVIDER_SOURCES, fetchAnnouncementItems, type ProviderSource } from "./announcements/index.js";
import { buildNewModelEmbed } from "./embeds.js";
import { errorFields, type Logger } from "./logger.js";
import {
  fetchOpenRouterModels,
  resolveAlertPricing,
  type OpenRouterCatalog
} from "./openrouter.js";
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
  /** Base delay for transient OpenRouter catalog retries. */
  retryDelayMs?: number;
}

/**
 * Polls every provider once, notifies new confirmed model announcements, and
 * records notified models in seen-models.json. The very first poll only
 * establishes a baseline so historical entries are not announced. Resolved
 * prices ride along on the embed; a pricing failure never blocks an alert.
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
  const pending: Array<{ source: ProviderSource; freshModels: string[]; alert: NewModelAnnouncement }> = [];

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
      pending.push({
        source,
        freshModels,
        alert: {
          providerId: source.id,
          providerName: source.providerName,
          title: item.title,
          url: item.url,
          ...(item.summary ? { summary: item.summary } : {}),
          modelIds: freshModels,
          stage: item.stage,
          ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
          detectedAt: now.toISOString()
        }
      });
    }
  }

  // One pricing catalog per run, loaded only when something is fresh — quiet
  // polls make zero OpenRouter requests.
  const catalog = pending.length === 0 ? undefined : await loadPricingCatalog(deps);

  let notified = 0;
  for (const { source, freshModels, alert } of pending) {
    const pricingByModel = catalog ? resolveAlertPricing(catalog, source.id, freshModels) : {};
    const enriched: NewModelAnnouncement = {
      ...alert,
      ...(Object.keys(pricingByModel).length > 0 ? { pricingByModel } : {})
    };
    try {
      await deps.send(buildNewModelEmbed(enriched, deps.timeZone));
    } catch (error) {
      // Leave the models unseen so the next poll retries this alert. A
      // pricing failure is not a send failure, so it never delays recording.
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

  if (baseline) {
    deps.store.saveSeenModels(additions);
    deps.logger.info("provider baseline established", { models: additions.length });
  } else if (additions.length > 0) {
    deps.store.saveSeenModels([...seen, ...additions]);
  }
  return notified;
}

/**
 * Loads the pricing catalog, degrading to "no prices" (with a warn log) on
 * any failure so a pricing outage never blocks an alert.
 */
async function loadPricingCatalog(deps: AlertsDeps): Promise<OpenRouterCatalog | undefined> {
  try {
    return await fetchOpenRouterModels({
      fetchFn: deps.fetchFn,
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {})
    });
  } catch (error) {
    deps.logger.warn(
      "OpenRouter pricing unavailable; posting alerts without prices",
      errorFields(error)
    );
    return undefined;
  }
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
