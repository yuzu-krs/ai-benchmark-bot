import { formatLocalDate, formatLocalDateTime } from "./time.js";
import type {
  EmbedPayload,
  NewModelAnnouncement,
  RankedModel,
  RankingSnapshot
} from "./types.js";

const RANK_MEDALS = ["🥇", "🥈", "🥉"] as const;
const EMBED_FIELD_LIMIT = 1024;
const SUMMARY_LIMIT = 1000;

export interface RankComparison {
  entry: RankedModel;
  previousRank?: number;
  /** Positive means the model moved up (a smaller rank number). */
  delta?: number;
  isNew: boolean;
}

/**
 * Compares the fresh board with the previous snapshot. When no previous
 * snapshot exists (first run) nothing is marked NEW and every entry shows ➖.
 */
export function compareWithPrevious(
  entries: RankedModel[],
  previous?: RankingSnapshot
): RankComparison[] {
  const priorRanks = new Map(previous?.entries.map((entry) => [entry.entityKey, entry.rank]));
  const hasBaseline = priorRanks.size > 0;
  return entries.map((entry) => {
    const previousRank = priorRanks.get(entry.entityKey);
    return {
      entry,
      ...(previousRank !== undefined
        ? { previousRank, delta: previousRank - entry.rank }
        : {}),
      isNew: hasBaseline && previousRank === undefined
    };
  });
}

export function formatRankLine(
  comparison: RankComparison,
  maxNameLength = 36,
  includeScore = true
): string {
  const { entry } = comparison;
  const medal = RANK_MEDALS[entry.rank - 1] ?? "";
  const name = truncateText(entry.name, maxNameLength);
  const label = medal ? `${medal} ${entry.rank}. ${name}` : `${entry.rank}. ${name}`;
  if (!includeScore) return `${label} ${deltaText(comparison)}`;
  return `${label} · ${entry.scoreDisplay} ${deltaText(comparison)}`;
}

function deltaText(comparison: RankComparison): string {
  if (comparison.isNew) return "🆕 NEW";
  if (comparison.delta === undefined || comparison.delta === 0) return "➖";
  return comparison.delta > 0 ? `⬆️ +${comparison.delta}` : `⬇️ ${comparison.delta}`;
}

export interface BoardView {
  board: "overall" | "coding";
  title: string;
  emoji: string;
  entries?: RankComparison[];
}

export function buildDailyRankingEmbed(params: {
  boards: BoardView[];
  now: Date;
  timeZone: string;
}): EmbedPayload {
  const fields = params.boards.map((board) => ({
    name: `${board.emoji} ${board.title}`,
    value: board.entries
      ? buildBoardValue(board.entries)
      : "⚠️ ランキングを取得できませんでした。"
  }));
  return {
    title: "📊 AI Benchmark Daily",
    description: `📅 ${formatLocalDate(params.now, params.timeZone)}\n🕒 Updated: ${formatLocalDateTime(params.now, params.timeZone)}`,
    color: 0x5865f2,
    fields,
    footer: { text: "⬆️ 上昇 · ⬇️ 下降 · ➖ 変動なし · 🆕 新規ランクイン" },
    timestamp: params.now.toISOString()
  };
}

/** Keeps one board's lines inside Discord's 1024-character field limit. */
export function buildBoardValue(comparisons: RankComparison[], limit = EMBED_FIELD_LIMIT): string {
  const attempts: Array<{ maxNameLength: number; includeScore: boolean }> = [
    { maxNameLength: 36, includeScore: true },
    { maxNameLength: 24, includeScore: true },
    { maxNameLength: 18, includeScore: false }
  ];
  for (const attempt of attempts) {
    const value = comparisons
      .map((comparison) =>
        formatRankLine(comparison, attempt.maxNameLength, attempt.includeScore)
      )
      .join("\n");
    if (value.length <= limit) return value;
  }
  const perLine = Math.floor((limit - 20) / Math.max(1, comparisons.length));
  return comparisons
    .map((comparison) => truncateText(formatRankLine(comparison, 18, false), perLine))
    .join("\n");
}

export function buildNewModelEmbed(alert: NewModelAnnouncement, timeZone: string): EmbedPayload {
  return {
    title: "🚀 New Model Alert!",
    color: 0x57f287,
    fields: [
      { name: "🏢 Provider", value: alert.providerName, inline: true },
      {
        name: "🧠 Model",
        value: truncateText(alert.modelIds.join(", "), EMBED_FIELD_LIMIT),
        inline: true
      },
      { name: "📝 Summary", value: truncateText(alert.summary ?? "（概要なし）", SUMMARY_LIMIT) },
      {
        name: "🕒 Detected",
        value: formatLocalDateTime(new Date(alert.detectedAt), timeZone),
        inline: true
      },
      { name: "🔗 Link", value: alert.url }
    ],
    timestamp: alert.detectedAt
  };
}

/** Surrogate-pair-safe truncation with an ellipsis marker. */
export function truncateText(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("").trimEnd()}…`;
}
