import type { APIEmbed } from "discord.js";
import type { Delivery } from "../application/ports.js";
import type {
  DomainEvent,
  EventType,
  LeaderboardEntry,
  LeaderboardId,
  SourceId,
  SourceStatus
} from "../domain/models.js";
import { SOURCE_IDS } from "../domain/models.js";
import { LEADERBOARD_LABELS } from "./commands.js";

const COLORS = {
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  error: 0xed4245
} as const;

const SOURCE_LABELS: Record<SourceId, string> = {
  lmarena: "LMArena",
  swebench: "SWE-bench",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  mistral: "Mistral AI",
  xai: "xAI",
  deepseek: "DeepSeek",
  meta: "Meta AI",
  qwen: "Qwen"
};

const OFFICIAL_URLS: Record<SourceId, string> = {
  lmarena: "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
  swebench:
    "https://github.com/SWE-bench/swe-bench.github.io/blob/master/data/leaderboards.json",
  openai: "https://developers.openai.com/api/docs/changelog",
  anthropic: "https://platform.claude.com/docs/en/release-notes/overview",
  google: "https://ai.google.dev/gemini-api/docs/changelog",
  mistral: "https://mistral.ai/news",
  xai: "https://docs.x.ai/developers/release-notes",
  deepseek: "https://api-docs.deepseek.com/updates",
  meta: "https://ai.meta.com/blog/",
  qwen: "https://qwen.ai/research"
};

const LEADERBOARD_URLS: Record<LeaderboardId, string> = {
  "lmarena-overall": OFFICIAL_URLS.lmarena,
  "lmarena-coding": OFFICIAL_URLS.lmarena,
  "swebench-verified":
    "https://github.com/SWE-bench/swe-bench.github.io/blob/master/data/leaderboards.json"
};

const EVENT_LABELS: Record<EventType, string> = {
  "provider.model_announced": "新モデル発表",
  "provider.announcement_candidate": "モデル発表候補（要確認）",
  "benchmark.entity_first_seen": "ベンチマーク初登場",
  "benchmark.entity_removed": "ランキング掲載終了",
  "benchmark.rank_changed": "ランキング変動",
  "benchmark.score_changed": "スコア変動",
  "benchmark.verification_changed": "検証状態の変更",
  "benchmark.definition_changed": "ベンチマーク定義の変更",
  "source.degraded": "取得元で障害を検出",
  "source.recovered": "取得元が復旧"
};

export function truncate(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  if (maximum <= 1) return "…".slice(0, maximum);
  let prefix = text.slice(0, maximum - 1);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function validHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function eventDescription(event: DomainEvent): string {
  const payload = event.payload;
  const entity = payload.entityName ?? payload.title ?? payload.entityKey ?? "対象項目";
  switch (event.type) {
    case "provider.model_announced":
      return `**${truncate(entity, 240)}** が公式に発表されました。`;
    case "provider.announcement_candidate":
      return `**${truncate(entity, 240)}** は新モデルの可能性があります。日次確認対象として記録しました。`;
    case "benchmark.entity_first_seen":
      return `**${truncate(entity, 240)}** がランキングに初登場しました。`;
    case "benchmark.entity_removed":
      return `**${truncate(entity, 240)}** の掲載終了を2回連続で確認しました。`;
    case "benchmark.rank_changed":
      return `**${truncate(entity, 240)}**: ${payload.oldRank ?? "?"}位 → **${payload.newRank ?? "?"}位**`;
    case "benchmark.score_changed":
      return `**${truncate(entity, 240)}**: ${payload.oldScore ?? "?"} → **${payload.newScore ?? "?"}**`;
    case "benchmark.verification_changed":
      return `**${truncate(entity, 240)}** の検証状態: **${payload.verified ? "Verified" : "未検証"}**`;
    case "benchmark.definition_changed":
      return truncate(payload.reason ?? "ランキングの方式または大規模な構成変更を検出しました。", 4_096);
    case "source.degraded":
      return truncate(payload.reason ?? "取得に3回連続で失敗しました。", 4_096);
    case "source.recovered":
      return "取得元への接続が復旧しました。";
  }
}

function eventColor(event: DomainEvent): number {
  if (event.type === "source.degraded") return COLORS.error;
  if (event.type === "source.recovered") return COLORS.success;
  if (event.type === "provider.announcement_candidate" || event.type === "benchmark.definition_changed") {
    return COLORS.warning;
  }
  return COLORS.info;
}

export function buildEventEmbed(event: DomainEvent): APIEmbed {
  const sourceUrl = validHttpUrl(event.payload.url) ?? OFFICIAL_URLS[event.sourceId];
  const fields: NonNullable<APIEmbed["fields"]> = [];
  if (event.leaderboardId) {
    fields.push({
      name: "ランキング",
      value: LEADERBOARD_LABELS[event.leaderboardId],
      inline: true
    });
  }
  if (event.payload.stage && event.payload.stage !== "unknown") {
    fields.push({ name: "公開段階", value: event.payload.stage, inline: true });
  }
  fields.push({ name: "公式情報", value: `[${SOURCE_LABELS[event.sourceId]}](${sourceUrl})` });

  return {
    title: truncate(EVENT_LABELS[event.type], 256),
    description: truncate(eventDescription(event), 4_096),
    color: eventColor(event),
    fields,
    footer: { text: truncate(`${SOURCE_LABELS[event.sourceId]} / ${event.type}`, 2_048) },
    timestamp: event.detectedAt
  };
}

function eventSummaryLine(event: DomainEvent): string {
  const payload = event.payload;
  const entity = truncate(payload.entityName ?? payload.title ?? payload.entityKey ?? SOURCE_LABELS[event.sourceId], 100);
  if (event.type === "benchmark.rank_changed") {
    return `• ${entity}: ${payload.oldRank ?? "?"}位 → ${payload.newRank ?? "?"}位`;
  }
  if (event.type === "benchmark.score_changed") {
    return `• ${entity}: ${payload.oldScore ?? "?"} → ${payload.newScore ?? "?"}`;
  }
  return `• ${EVENT_LABELS[event.type]}: ${entity}`;
}

function attributionFieldForSourceIds(
  values: readonly SourceId[]
): NonNullable<APIEmbed["fields"]>[number] | undefined {
  const sourceIds = [...new Set(values)];
  if (sourceIds.length === 0) return undefined;
  return {
    name: "公式出典",
    value: truncate(
      sourceIds.map((sourceId) => `[${SOURCE_LABELS[sourceId]}](${OFFICIAL_URLS[sourceId]})`).join(" / "),
      1_024
    )
  };
}

function attributionField(events: readonly DomainEvent[]): NonNullable<APIEmbed["fields"]>[number] | undefined {
  return attributionFieldForSourceIds(events.map((event) => event.sourceId));
}

export function buildDigestEmbed(
  events: readonly DomainEvent[],
  dateKey: string,
  totalCount = events.length,
  sourceIds: readonly SourceId[] = events.map((event) => event.sourceId)
): APIEmbed {
  const immediate = events.filter((event) => event.immediate);
  const regular = events.filter((event) => !event.immediate);
  const shownRegular = regular.slice(0, 18);
  const shownImmediate = immediate.slice(0, 10);
  const fields: NonNullable<APIEmbed["fields"]> = [];
  if (shownRegular.length > 0) {
    fields.push({
      name: "ランキング・スコア変動",
      value: truncate(shownRegular.map(eventSummaryLine).join("\n"), 1_024)
    });
  }
  if (shownImmediate.length > 0) {
    fields.push({
      name: "重要イベント（再掲）",
      value: truncate(shownImmediate.map(eventSummaryLine).join("\n"), 1_024)
    });
  }
  const omitted = Math.max(0, totalCount - shownRegular.length - shownImmediate.length);
  if (omitted > 0) {
    fields.push({ name: "省略", value: `ほか ${omitted} 件` });
  }
  const attribution = attributionFieldForSourceIds(sourceIds);
  if (attribution) fields.push(attribution);
  return {
    title: `AIベンチマーク 日次ダイジェスト — ${truncate(dateKey, 32)}`,
    description: `${totalCount}件の変動を検出しました。`,
    color: COLORS.info,
    fields: fields.slice(0, 25),
    footer: { text: "変動がない日は投稿されません" }
  };
}

export function buildTestEmbed(message = "通知設定は正常です。"): APIEmbed {
  return {
    title: "AIベンチマークBot テスト通知",
    description: truncate(message, 4_096),
    color: COLORS.success,
    footer: { text: "この通知ではメンションを送信しません" },
    timestamp: new Date().toISOString()
  };
}

export function buildRankingEmbed(
  leaderboardId: LeaderboardId,
  entries: readonly LeaderboardEntry[]
): APIEmbed {
  const lines = entries.map((entry) => {
    const verified = entry.verified === undefined ? "" : entry.verified ? " ✓" : "";
    return `**${entry.rank}位** ${truncate(entry.name, 100)} — ${truncate(entry.scoreDisplay, 30)}${verified}`;
  });
  return {
    title: truncate(LEADERBOARD_LABELS[leaderboardId], 256),
    url: LEADERBOARD_URLS[leaderboardId],
    description: truncate(lines.join("\n") || "まだランキングを取得していません。", 4_096),
    color: COLORS.info,
    footer: { text: "取得元の表示精度に基づくスコアです" }
  };
}

export function buildChangesEmbed(events: readonly DomainEvent[], hours: number): APIEmbed {
  const attribution = attributionField(events);
  return {
    title: `直近${hours}時間の変動`,
    description: truncate(
      events.slice(0, 35).map(eventSummaryLine).join("\n") || "この期間に変動はありません。",
      4_096
    ),
    color: COLORS.info,
    fields: attribution ? [attribution] : undefined,
    footer: events.length > 35 ? { text: `ほか ${events.length - 35} 件` } : undefined
  };
}

function formatStatus(status: SourceStatus): string {
  const health = !status.enabled ? "停止" : status.health === "healthy" ? "正常" : "障害";
  const success = status.lastSuccessAt ? `<t:${Math.floor(Date.parse(status.lastSuccessAt) / 1_000)}:R>` : "未取得";
  const revision = status.checkpoint?.revision ?? status.checkpoint?.contentHash?.slice(0, 8) ?? "—";
  return `**${SOURCE_LABELS[status.sourceId]}**: ${health} / 成功 ${success} / 失敗 ${status.consecutiveFailures}回 / rev ${truncate(revision, 20)}`;
}

export function buildStatusEmbed(statuses: readonly SourceStatus[]): APIEmbed {
  return {
    title: "監視ステータス",
    description: truncate(
      statuses.map(formatStatus).join("\n") || "取得元の状態はまだ記録されていません。",
      4_096
    ),
    color: statuses.some((status) => status.health === "degraded") ? COLORS.warning : COLORS.success,
    timestamp: new Date().toISOString()
  };
}

function isDomainEvent(value: unknown): value is DomainEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.type === "string" &&
    typeof record.sourceId === "string" &&
    typeof record.detectedAt === "string" &&
    !!record.payload &&
    typeof record.payload === "object"
  );
}

export function embedsForDelivery(delivery: Delivery): APIEmbed[] {
  if (delivery.kind === "test") {
    const message = typeof delivery.payload.message === "string" ? delivery.payload.message : undefined;
    return [buildTestEmbed(message)];
  }
  if (delivery.kind === "event") {
    const event = isDomainEvent(delivery.payload.event)
      ? delivery.payload.event
      : isDomainEvent(delivery.payload)
        ? delivery.payload
        : undefined;
    if (!event) throw new Error(`Delivery ${delivery.id} has an invalid event payload`);
    return [buildEventEmbed(event)];
  }

  const eventsValue = delivery.payload.events;
  const events = Array.isArray(eventsValue) ? eventsValue.filter(isDomainEvent) : [];
  const dateKey = typeof delivery.payload.dateKey === "string" ? delivery.payload.dateKey : "本日";
  const payloadCount = delivery.payload.totalCount;
  const totalCount =
    typeof payloadCount === "number" && Number.isInteger(payloadCount) && payloadCount >= events.length
      ? payloadCount
      : events.length;
  const payloadSourceIds = Array.isArray(delivery.payload.sourceIds)
    ? delivery.payload.sourceIds.filter(
        (value): value is SourceId =>
          typeof value === "string" && (SOURCE_IDS as readonly string[]).includes(value)
      )
    : events.map((event) => event.sourceId);
  return [buildDigestEmbed(events, dateKey, totalCount, payloadSourceIds)];
}
