import { describe, expect, it } from "vitest";
import {
  buildBoardValue,
  buildDailyRankingEmbed,
  buildNewModelEmbed,
  buildPricingFieldValue,
  compareWithPrevious,
  formatRankLine,
  truncateText,
  type BoardView
} from "../src/embeds.js";
import type { NewModelAnnouncement, RankedModel, RankingSnapshot } from "../src/types.js";

function model(rank: number, name = `model-${rank}`): RankedModel {
  return { entityKey: name, name, rank, score: 1500 - rank, scoreDisplay: String(1500 - rank) };
}

function snapshot(entries: RankedModel[]): RankingSnapshot {
  return { savedAt: "2026-08-15T22:00:00.000Z", entries };
}

describe("rank comparison", () => {
  it("computes deltas, keeps unchanged entries flat, and marks new entries", () => {
    const previous = snapshot([model(1, "model-x"), model(2, "model-b"), model(3, "model-a")]);
    const current = [model(1, "model-a"), model(2, "model-b"), model(3, "model-c")];
    const comparisons = compareWithPrevious(current, previous);
    expect(comparisons[0]).toMatchObject({ previousRank: 3, delta: 2, isNew: false });
    expect(comparisons[1]).toMatchObject({ previousRank: 2, delta: 0, isNew: false });
    expect(comparisons[2]).toMatchObject({ isNew: true });
    expect(comparisons[2]?.previousRank).toBeUndefined();
  });

  it("treats the very first run as flat: no NEW markers", () => {
    const comparisons = compareWithPrevious([model(1), model(2)], undefined);
    expect(comparisons.map((comparison) => formatRankLine(comparison))).toEqual([
      "🥇 1. model-1 · 1499 ➖",
      "🥈 2. model-2 · 1498 ➖"
    ]);
  });
});

describe("rank line formatting", () => {
  it("medals the top three and formats deltas at a glance", () => {
    const lines = [
      formatRankLine({ entry: model(1, "Model A"), previousRank: 3, delta: 2, isNew: false }),
      formatRankLine({ entry: model(2, "Model B"), previousRank: 2, delta: 0, isNew: false }),
      formatRankLine({ entry: model(3, "Model C"), previousRank: 2, delta: -1, isNew: false }),
      formatRankLine({ entry: model(4, "Model D"), isNew: true }),
      formatRankLine({ entry: model(10, "Model J"), previousRank: 7, delta: -3, isNew: false })
    ];
    expect(lines).toEqual([
      "🥇 1. Model A · 1499 ⬆️ +2",
      "🥈 2. Model B · 1498 ➖",
      "🥉 3. Model C · 1497 ⬇️ -1",
      "4. Model D · 1496 🆕 NEW",
      "10. Model J · 1490 ⬇️ -3"
    ]);
  });

  it("truncates surrogate pairs safely", () => {
    const truncated = truncateText("😀".repeat(50), 10);
    expect(Array.from(truncated).length).toBeLessThanOrEqual(11);
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("appends resolved prices to ranking lines", () => {
    const comparison = {
      entry: model(1, "Model A"),
      previousRank: 3,
      delta: 2,
      isNew: false,
      priceDisplay: "$1.25/$10"
    };
    expect(formatRankLine(comparison)).toBe("🥇 1. Model A · 1499 · $1.25/$10 ⬆️ +2");
    expect(formatRankLine(comparison, 36, false)).toBe("🥇 1. Model A · $1.25/$10 ⬆️ +2");
    expect(formatRankLine(comparison, 36, true, false)).toBe("🥇 1. Model A · 1499 ⬆️ +2");
  });

  it("renders byte-identical lines when no price resolved", () => {
    const comparison = { entry: model(2, "Model B"), previousRank: 2, delta: 0, isNew: false };
    expect(formatRankLine(comparison)).toBe("🥈 2. Model B · 1498 ➖");
  });
});

describe("daily ranking embed", () => {
  const now = new Date("2026-08-16T07:00:30.000Z");
  const BASE_DESCRIPTION = "📅 2026/08/16\n🕒 Updated: 2026/08/16 16:00 JST";
  const BASE_FOOTER =
    "⬆️ 上昇 · ⬇️ 下降 · ➖ 変動なし · 🆕 新規ランクイン · 💰 入力/出力 $/1Mトークン";

  it("builds the two board fields with the legend footer", () => {
    const embed = buildDailyRankingEmbed({
      boards: [
        {
          board: "lmarena-overall",
          title: "LMArena Overall",
          emoji: "🏆",
          entries: compareWithPrevious([model(1, "Model A")], snapshot([model(2, "Model A")]))
        },
        { board: "lmarena-coding", title: "LMArena Coding", emoji: "💻" }
      ],
      now,
      timeZone: "Asia/Tokyo"
    });
    expect(embed.title).toBe("📊 AI Benchmark Daily");
    expect(embed.fields.map((field) => field.name)).toEqual([
      "🏆 LMArena Overall",
      "💻 LMArena Coding"
    ]);
    expect(embed.fields[0]?.value).toContain("🥇 1. Model A · 1499 ⬆️ +1");
    expect(embed.fields[1]?.value).toBe("⚠️ ランキングを取得できませんでした。");
    expect(embed.description).toContain("📅 2026/08/16");
    expect(embed.description).toContain("🕒 Updated: 2026/08/16 16:00 JST");
    expect(embed.footer?.text).toContain("🆕 新規ランクイン");
  });

  it("stays byte-identical when meta is absent or empty", () => {
    const boards: BoardView[] = [
      { board: "lmarena-overall", title: "LMArena Overall", emoji: "🏆" },
      { board: "aa-intelligence", title: "AA Intelligence", emoji: "🧠" }
    ];
    const absent = buildDailyRankingEmbed({ boards, now, timeZone: "Asia/Tokyo" });
    const empty = buildDailyRankingEmbed({ boards, now, timeZone: "Asia/Tokyo", meta: {} });
    for (const embed of [absent, empty]) {
      expect(embed.description).toBe(BASE_DESCRIPTION);
      expect(embed.footer?.text).toBe(BASE_FOOTER);
    }
  });

  it("moves the AA credit and scale note into the footer, not the description", () => {
    const embed = buildDailyRankingEmbed({
      boards: [{ board: "aa-intelligence", title: "AA Intelligence", emoji: "🧠" }],
      now,
      timeZone: "Asia/Tokyo",
      meta: {
        aa: { intelligenceIndexVersion: "4.1", attributionUrl: "https://artificialanalysis.ai/" }
      }
    });
    expect(embed.description).toBe(BASE_DESCRIPTION);
    expect(embed.footer?.text).toBe(`${BASE_FOOTER} · 🧠 AA指数 0-100 · データ: artificialanalysis.ai`);
  });

  it("renders the same footer credit regardless of the reported version", () => {
    const withVersion = buildDailyRankingEmbed({
      boards: [],
      now,
      timeZone: "Asia/Tokyo",
      meta: { aa: { intelligenceIndexVersion: "4.1", attributionUrl: "https://artificialanalysis.ai/" } }
    });
    const withoutVersion = buildDailyRankingEmbed({
      boards: [],
      now,
      timeZone: "Asia/Tokyo",
      meta: { aa: { attributionUrl: "https://artificialanalysis.ai/" } }
    });
    for (const embed of [withVersion, withoutVersion]) {
      expect(embed.description).toBe(BASE_DESCRIPTION);
      expect(embed.footer?.text).toBe(`${BASE_FOOTER} · 🧠 AA指数 0-100 · データ: artificialanalysis.ai`);
    }
  });

  it("keeps a four-board embed inside Discord's total and per-field limits", () => {
    const entries = Array.from({ length: 10 }, (_unused, index) =>
      model(index + 1, `very-long-model-name-that-never-ends-${"x".repeat(60)}-${index}`)
    );
    const prices = new Map(entries.map((entry) => [entry.name, "$1.25/$10"]));
    const comparisons = compareWithPrevious(entries, undefined, prices);
    const embed = buildDailyRankingEmbed({
      boards: (
        [
          ["lmarena-overall", "LMArena Overall", "🏆"],
          ["lmarena-coding", "LMArena Coding", "💻"],
          ["aa-intelligence", "AA Intelligence", "🧠"],
          ["aa-coding", "AA Coding", "🛠️"]
        ] as const
      ).map(([board, title, emoji]) => ({ board, title, emoji, entries: comparisons })),
      now,
      timeZone: "Asia/Tokyo",
      meta: {
        aa: { intelligenceIndexVersion: "4.1", attributionUrl: "https://artificialanalysis.ai/" }
      }
    });
    expect(embed.fields).toHaveLength(4);
    for (const field of embed.fields) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(JSON.stringify(embed).length).toBeLessThan(6000);
  });

  it("keeps every field within Discord's 1024-character limit for long model names", () => {
    const longNames = Array.from({ length: 10 }, (_unused, index) =>
      model(index + 1, `very-long-model-name-that-never-ends-${"x".repeat(60)}-${index}`)
    );
    const value = buildBoardValue(compareWithPrevious(longNames, undefined));
    expect(value.length).toBeLessThanOrEqual(1024);
    expect(value.split("\n")).toHaveLength(10);
  });

  it("keeps priced boards inside the default limit", () => {
    const priced = Array.from({ length: 10 }, (_unused, index) => ({
      ...model(index + 1, `very-long-model-name-that-never-ends-${"x".repeat(60)}-${index}`),
      priceDisplay: "$1.25/$10"
    }));
    const value = buildBoardValue(priced.map((entry) => ({ entry, isNew: false })));
    expect(value.length).toBeLessThanOrEqual(1024);
    expect(value.split("\n")).toHaveLength(10);
  });

  it("drops prices before scores when the field overflows", () => {
    const priced = Array.from({ length: 10 }, (_unused, index) => ({
      ...model(index + 1, `very-long-model-name-that-never-ends-${"x".repeat(60)}-${index}`),
      priceDisplay: "$1.25/$10"
    }));
    // Tight enough that the price-bearing rungs overflow but the
    // score-bearing one still fits.
    const value = buildBoardValue(priced.map((entry) => ({ entry, isNew: false })), 380);
    expect(value.length).toBeLessThanOrEqual(380);
    expect(value).not.toContain("$");
    expect(value).toContain("1499");
  });

  it("explains the price notation in the footer legend", () => {
    const embed = buildDailyRankingEmbed({
      boards: [{ board: "lmarena-overall", title: "LMArena Overall", emoji: "🏆" }],
      now: new Date("2026-08-16T07:00:30.000Z"),
      timeZone: "Asia/Tokyo"
    });
    expect(embed.footer?.text).toContain("💰 入力/出力 $/1Mトークン");
  });
});

describe("new model embed", () => {
  it("renders provider, model, summary, detected time, and link", () => {
    const embed = buildNewModelEmbed(
      {
        providerId: "openai",
        providerName: "OpenAI",
        title: "GPT-X announced",
        url: "https://developers.openai.com/api/docs/changelog",
        summary: "新しいフラッグシップモデルが発表されました。",
        modelIds: ["gpt-x"],
        stage: "general_availability",
        detectedAt: "2026-08-16T03:30:00.000Z"
      },
      "Asia/Tokyo"
    );
    expect(embed.title).toBe("🚀 New Model Alert!");
    const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
    expect(fields["🏢 Provider"]).toBe("OpenAI");
    expect(fields["🧠 Model"]).toBe("gpt-x");
    expect(fields["📝 Summary"]).toContain("フラッグシップ");
    expect(fields["🕒 Detected"]).toBe("2026/08/16 12:30 JST");
    expect(fields["🔗 Link"]).toBe("https://developers.openai.com/api/docs/changelog");
  });

  it("falls back to a placeholder summary and truncates long ones", () => {
    const base = {
      providerId: "openai",
      providerName: "OpenAI",
      title: "t",
      url: "https://example.com",
      modelIds: ["gpt-x"],
      stage: "unknown" as const,
      detectedAt: "2026-08-16T03:30:00.000Z"
    };
    expect(buildNewModelEmbed(base, "Asia/Tokyo").fields[2]?.value).toBe("（概要なし）");
    const long = buildNewModelEmbed({ ...base, summary: "さ".repeat(2000) }, "Asia/Tokyo");
    expect(long.fields[2]?.value.length).toBeLessThanOrEqual(1001);
    expect(long.fields[2]?.value.endsWith("…")).toBe(true);
  });

  describe("pricing field", () => {
    const base = {
      providerId: "openai",
      providerName: "OpenAI",
      title: "t",
      url: "https://example.com",
      modelIds: ["gpt-x"],
      stage: "unknown" as const,
      detectedAt: "2026-08-16T03:30:00.000Z"
    };

    const fieldOf = (alert: NewModelAnnouncement): { name: string; value: string } | undefined =>
      buildNewModelEmbed(alert, "Asia/Tokyo").fields.find(
        (field) => field.name === "💰 価格 / コンテキスト"
      );

    it("omits the field entirely when nothing matched", () => {
      expect(buildPricingFieldValue(base)).toBeUndefined();
      expect(fieldOf(base)).toBeUndefined();
    });

    it("renders a single model inline with its context length", () => {
      const alert: NewModelAnnouncement = {
        ...base,
        pricingByModel: { "gpt-x": { priceDisplay: "$1.25/$10", contextDisplay: "400K" } }
      };
      expect(buildPricingFieldValue(alert)).toBe("$1.25/$10 · 400K");
      expect(fieldOf(alert)?.value).toBe("$1.25/$10 · 400K");
    });

    it("lists each model on its own line for multi-model alerts", () => {
      const alert: NewModelAnnouncement = {
        ...base,
        modelIds: ["gpt-x", "gpt-y", "gpt-z"],
        // gpt-z has no entry: only matched models appear.
        pricingByModel: {
          "gpt-x": { priceDisplay: "$1.25/$10", contextDisplay: "400K" },
          "gpt-y": { priceDisplay: "無料", contextDisplay: "1M" }
        }
      };
      expect(buildPricingFieldValue(alert)).toBe(
        "`gpt-x` — $1.25/$10 · 400K\n`gpt-y` — 無料 · 1M"
      );
    });

    it("caps very long lists and stays inside the field limit", () => {
      const modelIds = Array.from({ length: 40 }, (_unused, index) => `model-${index}`);
      const alert: NewModelAnnouncement = {
        ...base,
        modelIds,
        pricingByModel: Object.fromEntries(
          modelIds.map((modelId) => [modelId, { priceDisplay: "$1.25/$10", contextDisplay: "400K" }])
        )
      };
      const value = buildPricingFieldValue(alert)!;
      expect(value.split("\n")).toHaveLength(21);
      expect(value.endsWith("… 他20件")).toBe(true);
      expect(value.length).toBeLessThanOrEqual(1024);
    });

    it("truncates a huge single line to the field limit", () => {
      const alert: NewModelAnnouncement = {
        ...base,
        pricingByModel: { "gpt-x": { priceDisplay: "$".repeat(3000) } }
      };
      const value = buildPricingFieldValue(alert)!;
      expect(value.length).toBeLessThanOrEqual(1024);
      expect(value.endsWith("…")).toBe(true);
    });
  });
});
