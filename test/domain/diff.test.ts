import { describe, expect, it } from "vitest";

import {
  benchmarkContentHash,
  detectBenchmarkAnomaly,
  diffBenchmarkEntries,
  isImmediateRankChange,
  normalizeLeaderboardEntries
} from "../../src/domain/diff.js";
import type { BenchmarkSnapshot, LeaderboardEntry } from "../../src/domain/models.js";

function entry(
  entityKey: string,
  rank: number,
  score = 100 - rank,
  overrides: Partial<LeaderboardEntry> = {}
): LeaderboardEntry {
  return {
    entityKey,
    name: entityKey,
    rank,
    score,
    scoreDisplay: score.toFixed(2),
    ...overrides
  };
}

function snapshot(entries: LeaderboardEntry[]): BenchmarkSnapshot {
  return {
    kind: "benchmark",
    sourceId: "lmarena",
    leaderboardId: "lmarena-overall",
    leaderboardName: "LMArena Overall",
    category: "overall",
    entityType: "model",
    sourceUrl: "https://example.test/leaderboard",
    observedAt: "2026-08-14T00:00:00.000Z",
    version: "text_style_control",
    scorePrecision: 2,
    entries,
    checkpoint: { revision: "one" }
  };
}

describe("benchmark diff primitives", () => {
  it("rounds before comparison and treats reordering of ties as identical", () => {
    const first = snapshot([
      entry("a", 1, 1.2341, { scoreDisplay: "1.23" }),
      entry("b", 1, 1.2342, { scoreDisplay: "1.23" })
    ]);
    const reordered = snapshot([
      entry("b", 1, 1.2344, { scoreDisplay: "1.23" }),
      entry("a", 1, 1.2343, { scoreDisplay: "1.23" })
    ]);

    expect(benchmarkContentHash(first)).toBe(benchmarkContentHash(reordered));
    expect(normalizeLeaderboardEntries(first.entries, 2).map((item) => item.score)).toEqual([
      1.23, 1.23
    ]);
  });

  it("rejects duplicate entity keys before they can damage a baseline", () => {
    expect(() => normalizeLeaderboardEntries([entry("a", 1), entry("a", 2)], 2)).toThrow(
      /duplicate entityKey/
    );
  });

  it("detects the two anomaly thresholds at their inclusive boundaries", () => {
    const previous = Array.from({ length: 10 }, (_, index) => entry(`m${index}`, index + 1));
    const rowDrop = detectBenchmarkAnomaly(previous, previous.slice(0, 8));
    expect(rowDrop.anomalous).toBe(true);
    expect(rowDrop.rowDropRatio).toBeCloseTo(0.2);

    const moved = previous.map((item, index) => ({
      ...item,
      rank: index < 3 ? item.rank + 3 : item.rank
    }));
    const rankAnomaly = detectBenchmarkAnomaly(previous, moved);
    expect(rankAnomaly.anomalous).toBe(true);
    expect(rankAnomaly.top50MovementRatio).toBeCloseTo(0.3);

    const replaced = [...previous.slice(3), entry("new-a", 8), entry("new-b", 9), entry("new-c", 10)];
    const replacementAnomaly = detectBenchmarkAnomaly(previous, replaced);
    expect(replacementAnomaly.rowDropRatio).toBe(0);
    expect(replacementAnomaly.top50MovementRatio).toBeCloseTo(0.3);
    expect(replacementAnomaly.anomalous).toBe(true);
  });

  it("uses top-10 crossing and material top-50 movement for immediate rank changes", () => {
    expect(isImmediateRankChange(10, 11)).toBe(true);
    expect(isImmediateRankChange(20, 23)).toBe(true);
    expect(isImmediateRankChange(20, 22)).toBe(false);
    expect(isImmediateRankChange(51, 54)).toBe(false);
  });

  it("emits score changes only when the visible precision changes", () => {
    const next = snapshot([entry("a", 1, 1.239, { scoreDisplay: "1.24" })]);
    const result = diffBenchmarkEntries({
      snapshot: next,
      current: normalizeLeaderboardEntries(next.entries, 2),
      priorStates: [
        {
          ...entry("a", 1, 1.231, { scoreDisplay: "1.23" }),
          score: 1.23,
          active: true,
          missingCount: 0
        }
      ],
      changeToken: "revision-two"
    });
    expect(result.events.map((event) => event.type)).toEqual(["benchmark.score_changed"]);
    expect(result.events[0]?.payload).toMatchObject({ oldScore: 1.23, newScore: 1.24 });
  });
});
