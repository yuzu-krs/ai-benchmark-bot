import { buildDailyRankingEmbed, compareWithPrevious, type BoardView } from "./embeds.js";
import { errorFields, type Logger } from "./logger.js";
import { fetchLmArenaTop, LMARENA_BOARDS, type LmArenaBoard } from "./lmarena.js";
import type { StateStore } from "./state.js";
import { localDateKey } from "./time.js";
import type { EmbedPayload, RankedModel } from "./types.js";

// Presentation only: board identity and display names come from LMARENA_BOARDS.
const BOARD_PRESENTATION: Readonly<Record<LmArenaBoard, { emoji: string }>> = {
  overall: { emoji: "🏆" },
  coding: { emoji: "💻" }
};

const BOARDS: ReadonlyArray<LmArenaBoard> = ["overall", "coding"];

export interface RankingDeps {
  timeZone: string;
  store: StateStore;
  logger: Logger;
  send(embed: EmbedPayload): Promise<void>;
  fetchFn?: typeof globalThis.fetch;
  huggingFaceToken?: string;
  now?: () => Date;
  /** Base delay for transient-source retries inside each board fetch. */
  retryDelayMs?: number;
}

export interface RankingResult {
  dateKey: string;
  posted: boolean;
  boards: Record<LmArenaBoard, "ok" | "failed">;
}

/**
 * Fetches both LMArena boards, posts the daily ranking embed, then persists
 * the boards that succeeded. A failed board is reported inside the embed and
 * keeps its previous snapshot so the next comparison stays meaningful.
 */
export async function runDailyRanking(deps: RankingDeps): Promise<RankingResult> {
  const now = deps.now?.() ?? new Date();
  const dateKey = localDateKey(now, deps.timeZone);
  const results = await Promise.allSettled(
    BOARDS.map((board) =>
      fetchLmArenaTop(board, {
        fetchFn: deps.fetchFn,
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...(deps.huggingFaceToken ? { token: deps.huggingFaceToken } : {}),
        ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {})
      })
    )
  );

  const views: BoardView[] = [];
  const succeeded: Array<{ board: LmArenaBoard; entries: RankedModel[] }> = [];
  const boards: Record<LmArenaBoard, "ok" | "failed"> = { overall: "failed", coding: "failed" };
  results.forEach((result, index) => {
    const board = BOARDS[index];
    if (!board) return;
    const spec = LMARENA_BOARDS[board];
    if (result.status === "fulfilled") {
      boards[board] = "ok";
      const previous = deps.store.loadRanking(board);
      views.push({
        board,
        title: spec.displayName,
        emoji: BOARD_PRESENTATION[board].emoji,
        entries: compareWithPrevious(result.value, previous)
      });
      succeeded.push({ board, entries: result.value });
    } else {
      deps.logger.error("ranking fetch failed", {
        leaderboard: spec.leaderboardId,
        ...errorFields(result.reason)
      });
      views.push({
        board,
        title: spec.displayName,
        emoji: BOARD_PRESENTATION[board].emoji
      });
    }
  });

  // A send failure propagates to the caller: nothing is saved, so the next
  // scheduler tick retries the whole ranking for the same day.
  await deps.send(buildDailyRankingEmbed({ boards: views, now, timeZone: deps.timeZone }));

  const savedAt = now.toISOString();
  for (const { board, entries } of succeeded) {
    deps.store.saveRanking(board, entries, savedAt);
  }
  deps.store.saveLastPosted(dateKey, savedAt);
  deps.logger.info("daily ranking posted", {
    dateKey,
    overall: boards.overall,
    coding: boards.coding
  });
  return { dateKey, posted: true, boards };
}
