import { formatLocalDate, formatLocalDateTime } from "./time.js";
import type {
  EmbedField,
  EmbedPayload,
  NewModelAnnouncement,
  RankedModel,
  RankingBoard,
  RankingEmbedMeta,
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
  /** Short price appended to a ranking line, e.g. "$1.2/$12". Absent = unmatched. */
  priceDisplay?: string;
}

/**
 * Compares the fresh board with the previous snapshot. When no previous
 * snapshot exists (first run) nothing is marked NEW and every entry shows ➖.
 * `prices` maps leaderboard names to short price strings; unmatched names
 * simply render without a price.
 */
export function compareWithPrevious(
  entries: RankedModel[],
  previous?: RankingSnapshot,
  prices?: ReadonlyMap<string, string>
): RankComparison[] {
  const priorRanks = new Map(previous?.entries.map((entry) => [entry.entityKey, entry.rank]));
  const hasBaseline = priorRanks.size > 0;
  return entries.map((entry) => {
    const previousRank = priorRanks.get(entry.entityKey);
    const priceDisplay = prices?.get(entry.name);
    return {
      entry,
      ...(previousRank !== undefined
        ? { previousRank, delta: previousRank - entry.rank }
        : {}),
      ...(priceDisplay !== undefined ? { priceDisplay } : {}),
      isNew: hasBaseline && previousRank === undefined
    };
  });
}

export function formatRankLine(
  comparison: RankComparison,
  maxNameLength = 36,
  includeScore = true,
  includePrice = true
): string {
  const { entry } = comparison;
  const medal = RANK_MEDALS[entry.rank - 1] ?? "";
  const name = truncateText(entry.name, maxNameLength);
  const label = medal ? `${medal} ${entry.rank}. ${name}` : `${entry.rank}. ${name}`;
  const metrics = [
    ...(includeScore ? [entry.scoreDisplay] : []),
    ...(includePrice && comparison.priceDisplay !== undefined ? [comparison.priceDisplay] : [])
  ];
  if (metrics.length === 0) return `${label} ${deltaText(comparison)}`;
  return `${label} · ${metrics.join(" · ")} ${deltaText(comparison)}`;
}

function deltaText(comparison: RankComparison): string {
  if (comparison.isNew) return "🆕 NEW";
  if (comparison.delta === undefined || comparison.delta === 0) return "➖";
  return comparison.delta > 0 ? `⬆️ +${comparison.delta}` : `⬇️ ${comparison.delta}`;
}

export interface BoardView {
  board: RankingBoard;
  title: string;
  emoji: string;
  entries?: RankComparison[];
}

/** Unchanging legend; source-specific notations are appended after it. */
const FOOTER_LEGEND = "⬆️ 上昇 · ⬇️ 下降 · ➖ 変動なし · 🆕 新規ランクイン · 💰 入力/出力 $/1Mトークン";
const NO_RANKING_MESSAGE = "⚠️ ランキングを取得できませんでした。";

/**
 * Renders the daily embed. `meta` only shapes the footer: the AA scale note
 * plus a plain-text source credit (AA's terms of use make its attribution
 * mandatory, and embed footers render no markdown, so the credit is the bare
 * host name). A run without source meta keeps the exact two-board-era output.
 */
export function buildDailyRankingEmbed(params: {
  boards: BoardView[];
  now: Date;
  timeZone: string;
  meta?: RankingEmbedMeta;
}): EmbedPayload {
  const fields = params.boards.map((board) => ({
    name: `${board.emoji} ${board.title}`,
    value: board.entries ? buildBoardValue(board.entries) : NO_RANKING_MESSAGE
  }));
  const description = [
    `📅 ${formatLocalDate(params.now, params.timeZone)}`,
    `🕒 Updated: ${formatLocalDateTime(params.now, params.timeZone)}`
  ].join("\n");
  const credit = params.meta?.aa
    ? `データ: ${creditHost(params.meta.aa.attributionUrl)}`
    : undefined;
  return {
    title: "📊 AI Benchmark Daily",
    description,
    color: 0x5865f2,
    fields,
    footer: {
      text: [
        FOOTER_LEGEND,
        ...(params.meta?.aa ? ["🧠 AA指数 0-100"] : []),
        ...(credit ? [credit] : [])
      ].join(" · ")
    },
    timestamp: params.now.toISOString()
  };
}

/** Bare host for the footer credit; embed footers render no markdown links. */
function creditHost(url: string): string {
  return url.replace(/^https:\/\/(www\.)?/, "").replace(/\/+$/, "");
}

/** Keeps one board's lines inside Discord's 1024-character field limit. */
export function buildBoardValue(comparisons: RankComparison[], limit = EMBED_FIELD_LIMIT): string {
  // Prices are cosmetic: they shrink names first and drop before scores do.
  const attempts: Array<{ maxNameLength: number; includeScore: boolean; includePrice: boolean }> = [
    { maxNameLength: 36, includeScore: true, includePrice: true },
    { maxNameLength: 26, includeScore: true, includePrice: true },
    { maxNameLength: 22, includeScore: true, includePrice: false },
    { maxNameLength: 18, includeScore: false, includePrice: false }
  ];
  for (const attempt of attempts) {
    const value = comparisons
      .map((comparison) =>
        formatRankLine(comparison, attempt.maxNameLength, attempt.includeScore, attempt.includePrice)
      )
      .join("\n");
    if (value.length <= limit) return value;
  }
  const perLine = Math.floor((limit - 20) / Math.max(1, comparisons.length));
  return comparisons
    .map((comparison) => truncateText(formatRankLine(comparison, 18, false, false), perLine))
    .join("\n");
}

export function buildNewModelEmbed(alert: NewModelAnnouncement, timeZone: string): EmbedPayload {
  const pricingValue = buildPricingFieldValue(alert);
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
      ...(pricingValue
        ? [{ name: "💰 価格 / コンテキスト", value: pricingValue } satisfies EmbedField]
        : []),
      { name: "🔗 Link", value: alert.url }
    ],
    timestamp: alert.detectedAt
  };
}

/** Lines shown before the rest collapses into an "… 他n件" marker. */
const PRICING_FIELD_MAX_LINES = 20;

/**
 * Renders the alert's resolved prices ("$1.25/$10 · 200K" per model). Returns
 * undefined when nothing matched, so a pricing outage renders the exact
 * pre-pricing embed instead of an empty field.
 */
export function buildPricingFieldValue(alert: NewModelAnnouncement): string | undefined {
  const lines = alert.modelIds
    .map((modelId) => {
      const price = alert.pricingByModel?.[modelId];
      if (!price) return undefined;
      const context = price.contextDisplay !== undefined ? ` · ${price.contextDisplay}` : "";
      return alert.modelIds.length === 1
        ? `${price.priceDisplay}${context}`
        : `\`${modelId}\` — ${price.priceDisplay}${context}`;
    })
    .filter((line) => line !== undefined);
  if (lines.length === 0) return undefined;
  const visible =
    lines.length <= PRICING_FIELD_MAX_LINES
      ? lines
      : [...lines.slice(0, PRICING_FIELD_MAX_LINES), `… 他${lines.length - PRICING_FIELD_MAX_LINES}件`];
  return truncateText(visible.join("\n"), EMBED_FIELD_LIMIT);
}

/** Surrogate-pair-safe truncation with an ellipsis marker. */
export function truncateText(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("").trimEnd()}…`;
}
