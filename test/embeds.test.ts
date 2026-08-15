import { describe, expect, it } from "vitest";
import {
  buildBoardValue,
  buildDailyRankingEmbed,
  buildNewModelEmbed,
  compareWithPrevious,
  formatRankLine,
  truncateText
} from "../src/embeds.js";
import type { RankedModel, RankingSnapshot } from "../src/types.js";

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
});

describe("daily ranking embed", () => {
  const now = new Date("2026-08-16T07:00:30.000Z");

  it("builds the two board fields with the legend footer", () => {
    const embed = buildDailyRankingEmbed({
      boards: [
        {
          board: "overall",
          title: "LMArena Overall",
          emoji: "🏆",
          entries: compareWithPrevious([model(1, "Model A")], snapshot([model(2, "Model A")]))
        },
        { board: "coding", title: "LMArena Coding", emoji: "💻" }
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

  it("keeps every field within Discord's 1024-character limit for long model names", () => {
    const longNames = Array.from({ length: 10 }, (_unused, index) =>
      model(index + 1, `very-long-model-name-that-never-ends-${"x".repeat(60)}-${index}`)
    );
    const value = buildBoardValue(compareWithPrevious(longNames, undefined));
    expect(value.length).toBeLessThanOrEqual(1024);
    expect(value.split("\n")).toHaveLength(10);
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
});
