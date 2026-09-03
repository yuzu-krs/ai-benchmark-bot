import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";
import type { RankedModel, SeenModel } from "../src/types.js";

function newStore(): { store: StateStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "bot-state-"));
  return { store: new StateStore(dir), dir };
}

function entry(rank: number, name = `model-${rank}`): RankedModel {
  return { entityKey: name, name, rank, score: 1400 - rank, scoreDisplay: String(1400 - rank) };
}

describe("StateStore", () => {
  it("round-trips ranking snapshots per board", () => {
    const { store } = newStore();
    expect(store.loadRanking("lmarena-overall")).toBeUndefined();
    store.saveRanking("lmarena-overall", [entry(1), entry(2)], "2026-08-16T00:00:00.000Z");
    store.saveRanking("lmarena-coding", [entry(1)], "2026-08-16T00:00:00.000Z");
    expect(store.loadRanking("lmarena-overall")).toEqual({
      savedAt: "2026-08-16T00:00:00.000Z",
      entries: [entry(1), entry(2)]
    });
    expect(store.loadRanking("lmarena-coding")?.entries).toHaveLength(1);
  });

  it("round-trips the AA boards under their own filenames", () => {
    const { store, dir } = newStore();
    store.saveRanking("aa-intelligence", [entry(1)], "2026-08-16T00:00:00.000Z");
    store.saveRanking("aa-coding", [entry(1), entry(2)], "2026-08-16T00:00:00.000Z");
    expect(store.loadRanking("aa-intelligence")?.entries).toHaveLength(1);
    expect(store.loadRanking("aa-coding")?.entries).toHaveLength(2);
    // The board key is the whole filename: no source prefix is prepended.
    expect(existsSync(join(dir, "aa-intelligence.json"))).toBe(true);
    expect(existsSync(join(dir, "aa-coding.json"))).toBe(true);
  });

  it("reads LMArena snapshots from the pre-registry filenames", () => {
    const { store, dir } = newStore();
    writeFileSync(
      join(dir, "lmarena-overall.json"),
      JSON.stringify({ savedAt: "2026-08-15T22:00:00.000Z", entries: [entry(1)] }),
      "utf8"
    );
    expect(existsSync(join(dir, "lmarena-overall.json"))).toBe(true);
    expect(store.loadRanking("lmarena-overall")).toEqual({
      savedAt: "2026-08-15T22:00:00.000Z",
      entries: [entry(1)]
    });
  });

  it("writes JSON files atomically without leaving temporaries", () => {
    const { store, dir } = newStore();
    store.saveLastPosted("2026-08-16", "2026-08-15T22:00:00.000Z");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(dir, "last-posted.json"))).toBe(true);
    expect(store.loadLastPosted()).toEqual({ dateKey: "2026-08-16", postedAt: "2026-08-15T22:00:00.000Z" });
  });

  it("establishes, loads, and bounds the seen-model list", () => {
    const { store } = newStore();
    expect(store.hasSeenModels()).toBe(false);
    expect(store.loadSeenModels()).toEqual([]);

    const models: SeenModel[] = Array.from({ length: 600 }, (_unused, index) => ({
      key: `openai:model-${index}`,
      providerId: "openai",
      modelId: `model-${index}`,
      firstSeenAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
    }));
    store.saveSeenModels(models);
    expect(store.hasSeenModels()).toBe(true);
    const loaded = store.loadSeenModels();
    expect(loaded).toHaveLength(500);
    // Oldest records are dropped first.
    expect(loaded[0]?.modelId).toBe("model-100");
    expect(loaded.at(-1)?.modelId).toBe("model-599");
  });

  it("fails loudly on a corrupt state file", () => {
    const { store, dir } = newStore();
    writeFileSync(join(dir, "seen-models.json"), "{not json", "utf8");
    expect(() => store.loadSeenModels()).toThrow(/corrupt/);
  });
});
