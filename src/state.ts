import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RankedModel, RankingBoard, RankingSnapshot, SeenModel } from "./types.js";

export type { RankingBoard } from "./types.js";

/** Beyond this size the oldest seen-model records are dropped first. */
const SEEN_MODEL_LIMIT = 500;

interface SeenModelsFile {
  models: SeenModel[];
}

interface LastPostedFile {
  dateKey: string;
  postedAt: string;
}

export class StateStore {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
  }

  loadRanking(board: RankingBoard): RankingSnapshot | undefined {
    return this.#readJson<RankingSnapshot>(this.#rankingFile(board));
  }

  saveRanking(board: RankingBoard, entries: RankedModel[], savedAt: string): void {
    this.#writeJson(this.#rankingFile(board), { savedAt, entries } satisfies RankingSnapshot);
  }

  hasSeenModels(): boolean {
    return existsSync(this.#seenModelsFile());
  }

  loadSeenModels(): SeenModel[] {
    const file = this.#readJson<SeenModelsFile>(this.#seenModelsFile());
    return file ? file.models : [];
  }

  saveSeenModels(models: SeenModel[]): void {
    const bounded = [...models]
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))
      .slice(-SEEN_MODEL_LIMIT);
    this.#writeJson(this.#seenModelsFile(), { models: bounded } satisfies SeenModelsFile);
  }

  loadLastPosted(): LastPostedFile | undefined {
    return this.#readJson<LastPostedFile>(this.#lastPostedFile());
  }

  saveLastPosted(dateKey: string, postedAt: string): void {
    this.#writeJson(this.#lastPostedFile(), { dateKey, postedAt } satisfies LastPostedFile);
  }

  #rankingFile(board: RankingBoard): string {
    // The board key already carries its source prefix, so "lmarena-overall"
    // keeps the pre-registry filename unchanged.
    return join(this.#dataDir, `${board}.json`);
  }

  #seenModelsFile(): string {
    return join(this.#dataDir, "seen-models.json");
  }

  #lastPostedFile(): string {
    return join(this.#dataDir, "last-posted.json");
  }

  #readJson<T>(file: string): T | undefined {
    if (!existsSync(file)) return undefined;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`State file ${file} could not be read`, { cause: error });
    }
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new Error(`State file ${file} is corrupt; fix or remove it before restarting`, {
        cause: error
      });
    }
  }

  #writeJson(file: string, value: unknown): void {
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, file);
  }
}
