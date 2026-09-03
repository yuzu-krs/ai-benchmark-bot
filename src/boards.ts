import {
  AA_BOARDS,
  ARTIFICIAL_ANALYSIS_ATTRIBUTION_URL,
  collectArtificialAnalysisTop,
  createArtificialAnalysisLoader,
  type AaBoard
} from "./artificialanalysis.js";
import type { Logger } from "./logger.js";
import { fetchLmArenaTop, LMARENA_BOARDS, type LmArenaBoard } from "./lmarena.js";
import type {
  RankedModel,
  RankingBoard,
  RankingEmbedMeta,
  RankingSourceId
} from "./types.js";

/** Every ranking board, in daily-embed field order. */
export const ALL_RANKING_BOARDS: readonly RankingBoard[] = [
  "lmarena-overall",
  "lmarena-coding",
  "aa-intelligence",
  "aa-coding"
];

/** TOP display size shared by every board. */
const TOP_N = 10;

export interface RankedBoardContext {
  fetchFn?: typeof globalThis.fetch;
  logger?: Logger;
  retryDelayMs?: number;
  huggingFaceToken?: string;
  aaApiKey?: string;
}

/** One fetchable board: identity for embed, logs, and state, plus its fetch. */
export interface RankedBoardSpec {
  readonly sourceId: RankingSourceId;
  readonly board: RankingBoard;
  readonly leaderboardId: string;
  readonly displayName: string;
  readonly emoji: string;
  fetch(): Promise<RankedModel[]>;
}

/** Transport options shared by every source adapter of one run. */
interface SharedTransport {
  fetchFn?: typeof globalThis.fetch;
  logger?: Logger;
  retryDelayMs?: number;
}

/**
 * Maps each source board onto its ranking key. The `satisfies` clauses keep
 * the mapping exhaustive in both directions: adding a board to a source
 * registry is a compile error until it is adapted here.
 */
const LMARENA_RANKING_BOARDS = {
  overall: "lmarena-overall",
  coding: "lmarena-coding"
} satisfies Record<LmArenaBoard, RankingBoard>;

const AA_RANKING_BOARDS = {
  intelligence: "aa-intelligence",
  coding: "aa-coding"
} satisfies Record<AaBoard, RankingBoard>;

/** Presentation-only emojis carried over from the pre-registry ranking. */
const LMARENA_BOARD_EMOJI: Readonly<Record<LmArenaBoard, string>> = {
  overall: "🏆",
  coding: "💻"
};

/**
 * Builds the fetchable boards for one run plus the attribution metadata for
 * the embed. AA boards exist only when `aaApiKey` is configured — an unset
 * key omits them silently (reported as skipped, never as a failure). Both AA
 * boards share one memoized loader, so a full run costs at most the source's
 * page cap regardless of how many AA boards are rendered, and `embedMeta()`
 * reuses that memoized promise instead of fetching again.
 */
export function buildRankedBoards(context: RankedBoardContext): {
  boards: readonly RankedBoardSpec[];
  embedMeta(): Promise<RankingEmbedMeta>;
} {
  const shared: SharedTransport = {
    fetchFn: context.fetchFn,
    ...(context.logger ? { logger: context.logger } : {}),
    ...(context.retryDelayMs !== undefined ? { retryDelayMs: context.retryDelayMs } : {})
  };

  const lmarenaBoards: RankedBoardSpec[] = (Object.keys(LMARENA_BOARDS) as LmArenaBoard[]).map(
    (board) => {
      const spec = LMARENA_BOARDS[board];
      return {
        sourceId: "lmarena",
        board: LMARENA_RANKING_BOARDS[board],
        leaderboardId: spec.leaderboardId,
        displayName: spec.displayName,
        emoji: LMARENA_BOARD_EMOJI[board],
        fetch: () =>
          fetchLmArenaTop(board, {
            ...shared,
            topN: TOP_N,
            ...(context.huggingFaceToken ? { token: context.huggingFaceToken } : {})
          })
      };
    }
  );

  // One memoized loader captured by both AA boards' fetch closures.
  const aaLoader = context.aaApiKey
    ? createArtificialAnalysisLoader({ ...shared, apiKey: context.aaApiKey })
    : undefined;
  const aaSucceeded = new Set<AaBoard>();
  const aaBoards: RankedBoardSpec[] = aaLoader
    ? (Object.keys(AA_BOARDS) as AaBoard[]).map((board) =>
        buildAaSpec(board, aaLoader, aaSucceeded)
      )
    : [];

  const embedMeta = async (): Promise<RankingEmbedMeta> => {
    const meta: RankingEmbedMeta = {};
    if (aaLoader && aaSucceeded.size > 0) {
      // Memoized: this resolves from the run's existing promise and issues no
      // new request; the catch only keeps this function unable to reject.
      const list = await aaLoader.load().catch(() => undefined);
      const version = list?.intelligenceIndexVersion;
      meta.aa = {
        ...(version ? { intelligenceIndexVersion: version } : {}),
        attributionUrl: ARTIFICIAL_ANALYSIS_ATTRIBUTION_URL
      };
    }
    return meta;
  };

  return { boards: [...lmarenaBoards, ...aaBoards], embedMeta };
}

/**
 * One AA board's fetch: the shared loader's single list, sliced per board.
 * Success is recorded only after the board's rows collect cleanly, so a list
 * that loads but yields an unusable board still stays unattributed.
 */
function buildAaSpec(
  board: AaBoard,
  aaLoader: ReturnType<typeof createArtificialAnalysisLoader>,
  aaSucceeded: Set<AaBoard>
): RankedBoardSpec {
  const spec = AA_BOARDS[board];
  return {
    sourceId: "aa",
    board: AA_RANKING_BOARDS[board],
    leaderboardId: spec.leaderboardId,
    displayName: spec.displayName,
    emoji: spec.emoji,
    fetch: () =>
      aaLoader.load().then((list) => {
        const entries = collectArtificialAnalysisTop(
          list.models,
          board,
          TOP_N,
          spec.leaderboardId
        );
        aaSucceeded.add(board);
        return entries;
      })
  };
}
