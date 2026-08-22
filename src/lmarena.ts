import { z } from "zod";
import { fetchText, HttpError, parseJson } from "./http.js";
import type { Logger } from "./logger.js";
import type { RankedModel } from "./types.js";

/**
 * Stable internal board id. Also the state-file key (`lmarena-<board>.json`),
 * so it must never change once released; source-side identifiers live only in
 * LMARENA_BOARDS below.
 */
export type LmArenaBoard = "overall" | "coding";

export interface LmArenaBoardSpec {
  readonly board: LmArenaBoard;
  /** Identity used in logs, e.g. `lmarena-overall`. */
  readonly leaderboardId: string;
  /** Discord display name, e.g. `LMArena Overall`. */
  readonly displayName: string;
  /**
   * Source-specific fetch identity, decoupled from ids and display names.
   * Every board reads the /rows endpoint first — /filter needs a server-side
   * dataset index that has stayed unavailable ("Unexpected error." /
   * "dataset index is loading") for a day or more on this dataset, while
   * /rows serves the same data straight from parquet. When /rows itself is
   * transport-unavailable (e.g. 501 "the dataset is currently locked" while
   * a config is reprocessed), the first page falls back to /first-rows,
   * which is served from the dataset-viewer cache and survives those locks.
   */
  readonly fetch:
    | { readonly kind: "config"; readonly config: string }
    | {
        readonly kind: "category";
        readonly config: string;
        readonly categoryKeys: readonly string[];
      };
}

/**
 * Board registry. When upstream renames a category value, extend the
 * candidate list here — board ids, display names, and state files stay put.
 */
export const LMARENA_BOARDS: Readonly<Record<LmArenaBoard, LmArenaBoardSpec>> = {
  overall: {
    board: "overall",
    leaderboardId: "lmarena-overall",
    displayName: "LMArena Overall",
    // Category rows are picked client-side from /rows pages. Upstream has
    // renamed category values before ("text" no longer exists in this
    // config; "overall" is current), so candidates are tried in priority
    // order against the same fetched rows and a rename costs no extra
    // requests. Pages arrive grouped by category and rank-ascending within
    // each group, so paging stops once one key collected enough rows.
    fetch: { kind: "category", config: "text_style_control", categoryKeys: ["overall", "text"] }
  },
  coding: {
    board: "coding",
    leaderboardId: "lmarena-coding",
    displayName: "LMArena Coding",
    fetch: { kind: "config", config: "webdev" }
  }
};

const DATASET_ID = "lmarena-ai/leaderboard-dataset";
export const LMARENA_DATASET_URL = `https://huggingface.co/datasets/${DATASET_ID}`;
/** Only the first pages are fetched: the TOP10 display never needs deeper pages. */
const PAGE_SIZE = 100;
const PAGE_TIMEOUT_MS = 60_000;
const PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Safety cap on /rows pages walked while looking for a category group. */
const MAX_CATEGORY_PAGES = 5;

const arenaRowSchema = z
  .object({
    model_name: z.string().trim().min(1),
    organization: z.string().trim().nullable().optional(),
    license: z.string().trim().nullable().optional(),
    rating: z.number().finite(),
    vote_count: z.number().finite().nonnegative().optional(),
    rank: z.number().int().positive(),
    // Only category boards read this. Both configs expose a category column —
    // webdev's groups even include an "overall" value that collides with the
    // overall board's key — so config boards must never be category-filtered.
    category: z.string().trim().min(1).optional(),
    leaderboard_publish_date: z.string().trim().min(1)
  })
  .passthrough();

const rowsPageSchema = z
  .object({
    rows: z.array(
      z
        .object({
          row_idx: z.number().int().nonnegative(),
          row: arenaRowSchema
        })
        .passthrough()
    ),
    num_rows_total: z.number().int().nonnegative().optional(),
    num_rows_per_page: z.number().int().positive().optional(),
    partial: z.boolean().optional()
  })
  .passthrough();

export type LmArenaRow = z.infer<typeof arenaRowSchema>;

export function parseLmArenaRowsPage(payload: unknown): {
  rows: LmArenaRow[];
  total: number;
} {
  const parsed = rowsPageSchema.parse(payload);
  if (parsed.partial === true) throw new Error("LMArena returned a partial dataset response");
  // /first-rows responses carry no pagination counters.
  return { rows: parsed.rows.map(({ row }) => row), total: parsed.num_rows_total ?? parsed.rows.length };
}

export interface FetchLmArenaOptions {
  topN?: number;
  token?: string;
  fetchFn?: typeof globalThis.fetch;
  logger?: Logger;
  /** Delay between retries of transient (5xx/429/timeout) failures. */
  retryDelayMs?: number;
}

/** Total transport attempts per URL before giving up on it. */
const MAX_TRANSPORT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;
/**
 * Retry backoff as multiples of retryDelayMs. HF config locks ("the dataset
 * is currently locked") are routinely minutes long; the growing delay rides
 * out the short ones before the /first-rows fallback takes over. With
 * MAX_TRANSPORT_ATTEMPTS = 3 only two waits ever run (5s, then 15s).
 */
const RETRY_BACKOFF_MULTIPLIERS = [1, 3] as const;

/**
 * Fetches the current TOP entries of one LMArena board. Boards are fetched
 * independently so a single board failure never blocks the other.
 */
export async function fetchLmArenaTop(
  board: LmArenaBoard,
  options: FetchLmArenaOptions = {}
): Promise<RankedModel[]> {
  const spec = LMARENA_BOARDS[board];
  const topN = options.topN ?? 10;
  if (!Number.isInteger(topN) || topN < 1 || topN > PAGE_SIZE) {
    throw new Error("topN must be an integer between 1 and 100");
  }
  const headers = {
    accept: "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
  };
  const requestOptions = {
    headers,
    maxBytes: PAGE_MAX_BYTES,
    // HF dataset queries are computed on demand and can exceed the common
    // 30-second source deadline even when the service is healthy.
    timeoutMs: PAGE_TIMEOUT_MS,
    fetchFn: options.fetchFn
  };
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const transport = {
    requestOptions,
    logger: options.logger,
    leaderboard: spec.leaderboardId,
    retryDelayMs
  };

  if (spec.fetch.kind === "config") {
    const first = await fetchFirstPageWithFallback(spec.fetch.config, transport);
    const page = parseLmArenaRowsPage(parseJson(first.text, spec.leaderboardId));
    return collectTop(page.rows, topN, spec, viaLabel(`config=${spec.fetch.config}`, first.via));
  }
  return fetchCategoryTop(spec, topN, transport);
}

type PageSource = "rows" | "first-rows";

function viaLabel(source: string, via: PageSource): string {
  return via === "first-rows" ? `${source} via /first-rows` : source;
}

/**
 * Fetches a board's first page from /rows, falling back to /first-rows when
 * /rows stays transport-unavailable after its retries (observed live as 501
 * "the dataset is currently locked" for 12+ hours while one config was
 * reprocessed). /first-rows is served from the dataset-viewer cache and
 * survives those locks, but has no pagination — callers get one page.
 */
async function fetchFirstPageWithFallback(
  config: string,
  transport: TransportOptions
): Promise<{ text: string; via: PageSource }> {
  try {
    return { text: await fetchPageText(rowsUrl(config, 0), transport), via: "rows" };
  } catch (error) {
    if (!isTransportError(error)) throw error;
    transport.logger?.warn("LMArena /rows unavailable; falling back to /first-rows", {
      leaderboard: transport.leaderboard,
      config,
      ...describeError(error)
    });
    return { text: await fetchPageText(firstRowsUrl(config), transport), via: "first-rows" };
  }
}

interface TransportOptions {
  requestOptions: {
    headers: Record<string, string>;
    maxBytes: number;
    timeoutMs: number;
    fetchFn?: typeof globalThis.fetch;
  };
  logger?: Logger;
  leaderboard: string;
  retryDelayMs: number;
}

/**
 * Pages through the config collecting rows of the wanted categories. Rows
 * arrive grouped by category and rank-ascending within each group, so a
 * key's TOP N is complete once N of its rows have been seen; keys beyond the
 * page cap that never appeared fall through to the next candidate. Only the
 * first page has the /first-rows fallback — deeper pages are only reached
 * when /rows already proved healthy.
 */
async function fetchCategoryTop(
  spec: LmArenaBoardSpec,
  topN: number,
  transport: TransportOptions
): Promise<RankedModel[]> {
  if (spec.fetch.kind !== "category") throw new Error("fetchCategoryTop requires a category board");
  const { config, categoryKeys } = spec.fetch;
  const counts = new Map<string, number>();
  const collected: LmArenaRow[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  const first = await fetchFirstPageWithFallback(config, transport);
  let page = parseLmArenaRowsPage(parseJson(first.text, spec.leaderboardId));
  for (let pageNumber = 1; ; pageNumber += 1) {
    total = page.total;
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      collected.push(row);
      if (row.category !== undefined) {
        counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
      }
    }
    offset += page.rows.length;
    // A config's schema is uniform: if no row so far carries a category
    // column, none will — stop walking pages that can never match.
    if (counts.size === 0) break;
    const ready = categoryKeys.find((key) => (counts.get(key) ?? 0) >= topN);
    if (ready !== undefined) {
      return collectTop(
        categoryRows(collected, ready),
        topN,
        spec,
        viaLabel(`category=${ready}`, first.via)
      );
    }
    // /first-rows has no pagination: whatever it returned is all there is.
    if (first.via === "first-rows") break;
    if (pageNumber >= MAX_CATEGORY_PAGES || offset >= total) break;
    page = parseLmArenaRowsPage(
      parseJson(await fetchPageText(rowsUrl(config, offset), transport), spec.leaderboardId)
    );
  }
  // No key reached topN within the pages walked: serve the highest-priority
  // key that appeared at all (its group may simply have fewer than topN
  // models, or start beyond the page cap).
  const partial = categoryKeys.find((key) => (counts.get(key) ?? 0) > 0);
  if (partial !== undefined) {
    return collectTop(
      categoryRows(collected, partial),
      topN,
      spec,
      viaLabel(`category=${partial}`, first.via)
    );
  }
  throw new Error(
    `LMArena ${spec.leaderboardId} found no rows for categories [${categoryKeys.join(", ")}] in config '${config}'` +
      (counts.size > 0
        ? `; observed categories: ${[...counts.keys()].sort().join(", ")}`
        : collected.length > 0
          ? `; fetched ${collected.length} rows but none had a category column`
          : "; the config returned no rows")
  );
}

/**
 * Fetches one URL, retrying transient failures (5xx / 429 / timeout) with
 * growing delays. The HF datasets-server intermittently answers 5xx while a
 * cold response warms up, 429s under rate limiting, and 501 "the dataset is
 * currently locked" while a config is reprocessed.
 */
async function fetchPageText(url: URL, transport: TransportOptions): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { text } = await fetchText(url.toString(), transport.requestOptions);
      return text;
    } catch (error) {
      transport.logger?.warn("LMArena leaderboard fetch attempt failed", {
        leaderboard: transport.leaderboard,
        url: url.toString(),
        attempt,
        ...describeError(error)
      });
      if (attempt >= MAX_TRANSPORT_ATTEMPTS || !isTransportError(error)) throw error;
      if (transport.retryDelayMs > 0) {
        const multiplier =
          RETRY_BACKOFF_MULTIPLIERS[attempt - 1] ?? RETRY_BACKOFF_MULTIPLIERS.at(-1) ?? 1;
        await new Promise((resolve) => setTimeout(resolve, transport.retryDelayMs * multiplier));
      }
    }
  }
}

function isTransportError(error: unknown): boolean {
  if (error instanceof HttpError) {
    const status = error.status ?? 0;
    return status >= 500 || status === 429;
  }
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError")
  );
}

function categoryRows(rows: readonly LmArenaRow[], category: string): LmArenaRow[] {
  return rows.filter((row) => row.category === category);
}

function collectTop(
  rows: readonly LmArenaRow[],
  topN: number,
  spec: LmArenaBoardSpec,
  source: string
): RankedModel[] {
  // Completeness proof: ranks are unique per board/category, so the fetched
  // window holds the true TOP entries iff its rank set is exactly
  // 1..length. Grouped rank-ascending order is an upstream data property,
  // not an API contract — a snapshot written in any other layout must fail
  // closed instead of silently posting a wrong leaderboard.
  const ranks = rows.map((row) => row.rank).sort((a, b) => a - b);
  const brokenAt = ranks.findIndex((rank, index) => rank !== index + 1);
  if (brokenAt !== -1) {
    throw new Error(
      `LMArena ${spec.leaderboardId} (${source}) ranks are not the consecutive run 1..${rows.length} ` +
        `(position ${brokenAt + 1} has rank ${ranks[brokenAt]}); refusing to serve an unverified TOP`
    );
  }
  // The upstream leaderboard can list the same model name as two separate
  // rows (e.g. different harness configurations). Keep the best-ranked row
  // per name so the TOP display shows one line per model.
  const byName = new Map<string, RankedModel>();
  for (const row of rows) {
    const model = toRankedModel(row);
    const existing = byName.get(model.name);
    if (!existing || preferred(model, existing)) byName.set(model.name, model);
  }
  const entries = [...byName.values()]
    .sort((a, b) => a.rank - b.rank || b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, topN);
  if (entries.length === 0) {
    throw new Error(`LMArena ${spec.leaderboardId} (${source}) produced no ranked entries`);
  }
  return entries;
}

function preferred(candidate: RankedModel, existing: RankedModel): boolean {
  return (
    candidate.rank < existing.rank ||
    (candidate.rank === existing.rank && candidate.score > existing.score) ||
    (candidate.rank === existing.rank &&
      candidate.score === existing.score &&
      candidate.name.localeCompare(existing.name) < 0)
  );
}

function describeError(error: unknown): { status?: number; error: string; response?: string } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      error: error.message,
      ...(error.bodyExcerpt ? { response: error.bodyExcerpt } : {})
    };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

function rowsUrl(config: string, offset: number): URL {
  const url = new URL("https://datasets-server.huggingface.co/rows");
  url.searchParams.set("dataset", DATASET_ID);
  url.searchParams.set("config", config);
  url.searchParams.set("split", "latest");
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("length", String(PAGE_SIZE));
  return url;
}

/** /first-rows serves only the first ~100 rows and takes no paging params. */
function firstRowsUrl(config: string): URL {
  const url = new URL("https://datasets-server.huggingface.co/first-rows");
  url.searchParams.set("dataset", DATASET_ID);
  url.searchParams.set("config", config);
  url.searchParams.set("split", "latest");
  return url;
}

function toRankedModel(row: LmArenaRow): RankedModel {
  const roundedRating = Math.round(row.rating);
  return {
    entityKey: row.model_name,
    name: row.model_name,
    ...(row.organization ? { organization: row.organization } : {}),
    rank: row.rank,
    score: roundedRating,
    scoreDisplay: String(roundedRating)
  };
}
