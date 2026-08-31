import { readFileSync } from "node:fs";
import { fetchOpenRouterModels, resolveRankingPricing } from "./src/openrouter.js";
import type { RankingSnapshot } from "./src/types.js";

const catalog = await fetchOpenRouterModels();
for (const board of ["overall", "coding"] as const) {
  const snapshot = JSON.parse(
    readFileSync(new URL(`./data/lmarena-${board}.json`, import.meta.url), "utf8")
  ) as RankingSnapshot;
  console.log(`== ${board} (savedAt ${snapshot.savedAt}) ==`);
  const prices = resolveRankingPricing(catalog, snapshot.entries.map((entry) => entry.name));
  for (const entry of snapshot.entries) {
    const price = prices.get(entry.name) ?? "（価格なし）";
    console.log(`  ${entry.rank}. ${entry.name} · ${entry.scoreDisplay} · ${price}`);
  }
}
