import { fingerprint } from "../core/hash.js";
import type {
  BenchmarkSnapshot,
  LeaderboardEntry,
  SourceAdapter,
  SourceAdapterContext,
  SourceCheckpoint
} from "../domain/models.js";
import { z } from "zod";
import { fetchResource, parseJson } from "./http.js";

const DATASET_ID = "lmarena-ai/leaderboard-dataset";
const DATASET_URL = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset";
const METADATA_URL = `https://huggingface.co/api/datasets/${DATASET_ID}`;
const CONFIG = "text_style_control";
const PAGE_SIZE = 100;
const MAX_ROWS_PER_CATEGORY = 10_000;
const PAGE_TIMEOUT_MS = 60_000;

const metadataSchema = z
  .object({
    id: z.literal(DATASET_ID),
    sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
    lastModified: z.string().min(1).optional()
  })
  .passthrough();

const arenaRowSchema = z
  .object({
    model_name: z.string().trim().min(1),
    organization: z.string().trim().nullable().optional(),
    license: z.string().trim().nullable().optional(),
    rating: z.number().finite(),
    rating_lower: z.number().finite().optional(),
    rating_upper: z.number().finite().optional(),
    variance: z.number().finite().optional(),
    vote_count: z.number().finite().nonnegative().optional(),
    rank: z.number().int().positive(),
    category: z.string().trim().min(1),
    leaderboard_publish_date: z.string().trim().min(1)
  })
  .passthrough();

const filterPageSchema = z
  .object({
    rows: z.array(
      z
        .object({
          row_idx: z.number().int().nonnegative(),
          row: arenaRowSchema
        })
        .passthrough()
    ),
    num_rows_total: z.number().int().nonnegative(),
    num_rows_per_page: z.number().int().positive(),
    partial: z.boolean().optional()
  })
  .passthrough();

export type LmArenaRow = z.infer<typeof arenaRowSchema>;

export function parseLmArenaFilterPage(payload: unknown, category: string): {
  rows: LmArenaRow[];
  total: number;
} {
  const parsed = filterPageSchema.parse(payload);
  if (parsed.partial === true) throw new Error("LMArena returned a partial dataset response");
  for (const wrapper of parsed.rows) {
    if (wrapper.row.category !== category) {
      throw new Error(
        `LMArena category mismatch: expected ${category}, received ${wrapper.row.category}`
      );
    }
  }
  return { rows: parsed.rows.map(({ row }) => row), total: parsed.num_rows_total };
}

export class LmArenaAdapter implements SourceAdapter {
  readonly id = "lmarena" as const;
  readonly displayName = "LMArena";
  readonly intervalMinutes = 180;
  readonly targets = ["lmarena-overall", "lmarena-coding"] as const;

  async poll(context: SourceAdapterContext): Promise<BenchmarkSnapshot[]> {
    const tokenHeaders = authorizationHeaders(context.huggingFaceToken);
    const metadataResult = await fetchResource(context.fetch, METADATA_URL, {
      checkpoint: context.checkpoint,
      headers: { ...tokenHeaders, accept: "application/json" },
      maxBytes: 2 * 1024 * 1024
    });
    if (metadataResult.status === "not_modified") return [];

    const metadata = metadataSchema.parse(parseJson(metadataResult.text, "LMArena metadata"));
    if (context.checkpoint?.revision === metadata.sha) return [];

    const [overallRows, codingRows] = await Promise.all([
      this.fetchCategory(context, "overall", tokenHeaders, metadata.sha),
      this.fetchCategory(context, "coding", tokenHeaders, metadata.sha)
    ]);
    const contentHash = fingerprint({ overallRows, codingRows });
    const checkpoint: SourceCheckpoint = {
      ...metadataResult.checkpoint,
      revision: metadata.sha,
      contentHash
    };
    if (!checkpoint.lastModified && metadata.lastModified) {
      const timestamp = Date.parse(metadata.lastModified);
      if (Number.isFinite(timestamp)) checkpoint.lastModified = new Date(timestamp).toUTCString();
    }

    return [
      makeSnapshot("overall", overallRows, context.now, checkpoint),
      makeSnapshot("coding", codingRows, context.now, checkpoint)
    ];
  }

  private async fetchCategory(
    context: SourceAdapterContext,
    category: "overall" | "coding",
    headers: Record<string, string>,
    expectedRevision: string
  ): Promise<LmArenaRow[]> {
    const collected: LmArenaRow[] = [];
    let expectedTotal: number | undefined;

    while (expectedTotal === undefined || collected.length < expectedTotal) {
      if (collected.length >= MAX_ROWS_PER_CATEGORY) {
        throw new Error(`LMArena ${category} exceeded the row safety limit`);
      }
      const url = new URL("https://datasets-server.huggingface.co/filter");
      url.searchParams.set("dataset", DATASET_ID);
      url.searchParams.set("config", CONFIG);
      url.searchParams.set("split", "latest");
      url.searchParams.set("where", `"category"='${category}'`);
      url.searchParams.set("offset", String(collected.length));
      url.searchParams.set("length", String(PAGE_SIZE));
      const result = await fetchResource(context.fetch, url.toString(), {
        headers: { ...headers, accept: "application/json" },
        maxBytes: 4 * 1024 * 1024,
        // HF filter queries are computed on demand and can exceed the common
        // 30-second source deadline even when the service is healthy.
        timeoutMs: PAGE_TIMEOUT_MS
      });
      if (result.status === "not_modified") {
        throw new Error("Unexpected 304 response while paging LMArena");
      }
      const pageRevision = result.checkpoint.revision;
      if (!pageRevision) {
        throw new Error(`LMArena ${category} response is missing the x-revision header`);
      }
      if (pageRevision !== expectedRevision) {
        throw new Error(
          `LMArena ${category} revision mismatch: metadata=${expectedRevision}, page=${pageRevision}`
        );
      }
      const page = parseLmArenaFilterPage(
        parseJson(result.text, `LMArena ${category}`),
        category
      );
      if (expectedTotal === undefined) {
        expectedTotal = page.total;
        if (expectedTotal < 1 || expectedTotal > MAX_ROWS_PER_CATEGORY) {
          throw new Error(`LMArena ${category} returned an invalid row count: ${expectedTotal}`);
        }
      } else if (page.total !== expectedTotal) {
        throw new Error(`LMArena ${category} changed while it was being paged`);
      }
      if (page.rows.length === 0) {
        throw new Error(`LMArena ${category} pagination stopped before all rows were returned`);
      }
      collected.push(...page.rows);
    }

    if (collected.length !== expectedTotal) {
      throw new Error(`LMArena ${category} returned more rows than declared`);
    }
    const keys = new Set(collected.map((row) => row.model_name));
    if (keys.size !== collected.length) {
      throw new Error(`LMArena ${category} returned duplicate model names`);
    }
    return collected;
  }
}

function makeSnapshot(
  category: "overall" | "coding",
  rows: LmArenaRow[],
  now: Date,
  checkpoint: SourceCheckpoint
): BenchmarkSnapshot {
  const entries: LeaderboardEntry[] = rows
    .map((row) => {
      const roundedRating = Math.round(row.rating);
      const metadata: Record<string, unknown> = {
        leaderboardPublishDate: row.leaderboard_publish_date
      };
      if (row.license) metadata.license = row.license;
      if (row.rating_lower !== undefined) metadata.ratingLower = row.rating_lower;
      if (row.rating_upper !== undefined) metadata.ratingUpper = row.rating_upper;
      if (row.vote_count !== undefined) metadata.voteCount = row.vote_count;
      return {
        entityKey: row.model_name,
        name: row.model_name,
        ...(row.organization ? { organization: row.organization } : {}),
        rank: row.rank,
        score: roundedRating,
        scoreDisplay: String(roundedRating),
        metadata
      };
    })
    .sort((a, b) => a.rank - b.rank || b.score - a.score || a.name.localeCompare(b.name));
  const sourceUpdatedAt = rows
    .map((row) => row.leaderboard_publish_date)
    .sort()
    .at(-1);

  return {
    kind: "benchmark",
    sourceId: "lmarena",
    leaderboardId: category === "overall" ? "lmarena-overall" : "lmarena-coding",
    leaderboardName: category === "overall" ? "LMArena Overall" : "LMArena Coding",
    category,
    entityType: "model",
    sourceUrl: DATASET_URL,
    observedAt: now.toISOString(),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    version: CONFIG,
    scorePrecision: 0,
    entries,
    checkpoint
  };
}

function authorizationHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function createLmArenaAdapter(): SourceAdapter {
  return new LmArenaAdapter();
}
