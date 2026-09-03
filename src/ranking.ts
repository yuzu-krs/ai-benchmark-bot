import { ALL_RANKING_BOARDS, buildRankedBoards } from "./boards.js";
import { buildDailyRankingEmbed, compareWithPrevious, type BoardView } from "./embeds.js";
import { errorFields, type Logger } from "./logger.js";
import {
  fetchOpenRouterModels,
  resolveRankingPricing,
  type OpenRouterCatalog
} from "./openrouter.js";
import type { StateStore } from "./state.js";
import { localDateKey } from "./time.js";
import type {
  EmbedPayload,
  RankedModel,
  RankingBoard,
  RankingEmbedMeta
} from "./types.js";

export interface RankingDeps {
  timeZone: string;
  store: StateStore;
  logger: Logger;
  send(embed: EmbedPayload): Promise<void>;
  fetchFn?: typeof globalThis.fetch;
  huggingFaceToken?: string;
  /** Artificial Analysis key; unset omits both AA boards instead of failing them. */
  aaApiKey?: string;
  now?: () => Date;
  /** Base delay for transient-source retries inside each board fetch. */
  retryDelayMs?: number;
}

export interface RankingResult {
  dateKey: string;
  posted: boolean;
  boards: Partial<Record<RankingBoard, "ok" | "failed">>;
  /** Boards whose source is not configured (e.g. no AA key); never failures. */
  skipped: readonly RankingBoard[];
}

/**
 * Fetches every configured board plus the OpenRouter pricing catalog in
 * parallel, posts the daily ranking embed, then persists the boards that
 * succeeded. A failed board is reported inside the embed and keeps its
 * previous snapshot so the next comparison stays meaningful; a failed
 * pricing fetch only costs the prices, never the post itself.
 */
export async function runDailyRanking(deps: RankingDeps): Promise<RankingResult> {
  const now = deps.now?.() ?? new Date();
  const dateKey = localDateKey(now, deps.timeZone);
  const { boards: specs, embedMeta } = buildRankedBoards({
    fetchFn: deps.fetchFn,
    logger: deps.logger,
    ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
    ...(deps.huggingFaceToken ? { huggingFaceToken: deps.huggingFaceToken } : {}),
    ...(deps.aaApiKey ? { aaApiKey: deps.aaApiKey } : {})
  });
  const configured = new Set(specs.map((spec) => spec.board));
  const skipped = ALL_RANKING_BOARDS.filter((board) => !configured.has(board));
  if (skipped.length > 0) {
    deps.logger.info("ranking boards skipped; source not configured", { boards: skipped });
  }

  const [results, pricingCatalog] = await Promise.all([
    Promise.allSettled(specs.map((spec) => spec.fetch())),
    fetchPricingCatalog(deps)
  ]);

  const views: BoardView[] = [];
  const succeeded: Array<{ board: RankingBoard; entries: RankedModel[] }> = [];
  const boards: Partial<Record<RankingBoard, "ok" | "failed">> = {};
  results.forEach((result, index) => {
    const spec = specs[index];
    if (!spec) return;
    if (result.status === "fulfilled") {
      boards[spec.board] = "ok";
      const previous = deps.store.loadRanking(spec.board);
      const prices = pricingCatalog
        ? resolveRankingPricing(pricingCatalog, result.value.map((entry) => entry.name))
        : undefined;
      views.push({
        board: spec.board,
        title: spec.displayName,
        emoji: spec.emoji,
        entries: compareWithPrevious(result.value, previous, prices)
      });
      succeeded.push({ board: spec.board, entries: result.value });
    } else {
      boards[spec.board] = "failed";
      deps.logger.error("ranking fetch failed", {
        leaderboard: spec.leaderboardId,
        ...errorFields(result.reason)
      });
      views.push({
        board: spec.board,
        title: spec.displayName,
        emoji: spec.emoji
      });
    }
  });

  // Unconditional: returns {} when no source ran, so the embed keeps its
  // meta-less shape whenever nothing succeeded.
  const meta: RankingEmbedMeta = await embedMeta();

  // A send failure propagates to the caller: nothing is saved, so the next
  // scheduler tick retries the whole ranking for the same day.
  await deps.send(
    buildDailyRankingEmbed({ boards: views, now, timeZone: deps.timeZone, meta })
  );

  const savedAt = now.toISOString();
  for (const { board, entries } of succeeded) {
    deps.store.saveRanking(board, entries, savedAt);
  }
  deps.store.saveLastPosted(dateKey, savedAt);
  deps.logger.info("daily ranking posted", {
    dateKey,
    boards,
    ...(skipped.length > 0 ? { skipped } : {})
  });
  return { dateKey, posted: true, boards, skipped };
}

/**
 * Loads the pricing catalog, degrading to "no prices" (with a warn log) on
 * any failure so a pricing outage never blocks the daily post.
 */
function fetchPricingCatalog(deps: RankingDeps): Promise<OpenRouterCatalog | undefined> {
  return fetchOpenRouterModels({
    fetchFn: deps.fetchFn,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {})
  }).catch((error: unknown) => {
    deps.logger.warn(
      "OpenRouter pricing unavailable; posting ranking without prices",
      errorFields(error)
    );
    return undefined;
  });
}
