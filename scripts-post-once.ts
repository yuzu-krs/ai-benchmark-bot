import { existsSync, readFileSync } from "node:fs";
import { ALL_RANKING_BOARDS } from "./src/boards.js";
import { fetchOpenRouterModels, resolveRankingPricing } from "./src/openrouter.js";
import type { RankingSnapshot } from "./src/types.js";

const catalog = await fetchOpenRouterModels();
for (const board of ALL_RANKING_BOARDS) {
  // Sources that have never run (e.g. no AA key yet) have no snapshot to show.
  const file = new URL(`./data/${board}.json`, import.meta.url);
  if (!existsSync(file)) continue;
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as RankingSnapshot;
  console.log(`== ${board} (savedAt ${snapshot.savedAt}) ==`);
  const prices = resolveRankingPricing(catalog, snapshot.entries.map((entry) => entry.name));
  for (const entry of snapshot.entries) {
    const price = prices.get(entry.name) ?? "（価格なし）";
    console.log(`  ${entry.rank}. ${entry.name} · ${entry.scoreDisplay} · ${price}`);
  }
}
