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
  /** Source-specific fetch identity, decoupled from ids and display names. */
  readonly fetch:
    | { readonly endpoint: "filter"; readonly categoryKeys: readonly string[] }
    | { readonly endpoint: "rows"; readonly config: string };
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
    // Candidate keys are tried in order; an HTTP error or an empty result
    // falls through to the next key. Upstream has been seen serving transient
    // 500s ("dataset index is loading") and renaming category values, so the
    // newest key comes first with the established one as fallback.
    fetch: { endpoint: "filter", categoryKeys: ["text", "overall"] }
  },
  coding: {
    board: "coding",
    leaderboardId: "lmarena-coding",
    displayName: "LMArena Coding",
    fetch: { endpoint: "rows", config: "webdev" }
  }
};

const DATASET_ID = "lmarena-ai/leaderboard-dataset";
export const LMARENA_DATASET_URL = `https://huggingface.co/datasets/${DATASET_ID}`;
/** Only the first page is fetched: the TOP10 display never needs deeper pages. */
const PAGE_SIZE = 100;
const PAGE_TIMEOUT_MS = 60_000;
const PAGE_MAX_BYTES = 4 * 1024 * 1024;

const arenaRowSchema = z
  .object({
    model_name: z.string().trim().min(1),
    organization: z.string().trim().nullable().optional(),
    license: z.string().trim().nullable().optional(),
    rating: z.number().finite(),
    vote_count: z.number().finite().nonnegative().optional(),
    rank: z.number().int().positive(),
    // The /rows endpoint (webdev config) has no server-side category filter,
    // so only /filter pages validate this column.
    category: z.string().trim().min(1).optional(),
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
  const page = parseLmArenaPagePayload(payload);
  for (const row of page.rows) {
    if (row.category !== category) {
      throw new Error(`LMArena category mismatch: expected ${category}, received ${row.category}`);
    }
  }
  return page;
}

export function parseLmArenaRowsPage(payload: unknown): {
  rows: LmArenaRow[];
  total: number;
} {
  return parseLmArenaPagePayload(payload);
}

function parseLmArenaPagePayload(payload: unknown): {
  rows: LmArenaRow[];
  total: number;
} {
  const parsed = filterPageSchema.parse(payload);
  if (parsed.partial === true) throw new Error("LMArena returned a partial dataset response");
  return { rows: parsed.rows.map(({ row }) => row), total: parsed.num_rows_total };
}

export interface FetchLmArenaOptions {
  topN?: number;
  token?: string;
  fetchFn?: typeof globalThis.fetch;
  logger?: Logger;
  /** Delay between retries of transient (5xx/timeout) failures. */
  retryDelayMs?: number;
}

/** Total transport attempts per key before giving up on that key. */
const MAX_TRANSPORT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;

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

  if (spec.fetch.endpoint === "rows") {
    const url = rowsUrl(spec.fetch.config);
    const text = await fetchPageText(url, `config=${spec.fetch.config}`, transport);
    const page = parseLmArenaRowsPage(parseJson(text, spec.leaderboardId));
    return collectTop(page, topN, spec, `config=${spec.fetch.config}`);
  }

  const attempts: string[] = [];
  for (const key of spec.fetch.categoryKeys) {
    const url = filterUrl(key);
    try {
      const text = await fetchPageText(url, `key=${key}`, { ...transport, key });
      const page = parseLmArenaFilterPage(parseJson(text, spec.leaderboardId), key);
      if (page.rows.length === 0) {
        throw new Error(`category key '${key}' returned no rows`);
      }
      return collectTop(page, topN, spec, `key=${key}`);
    } catch (error) {
      attempts.push(describeAttempt(key, url.toString(), error));
      // Transport failures were already logged (and retried) inside
      // fetchPageText; only parse/validation problems are logged here.
      if (!isTransportError(error)) {
        options.logger?.warn("LMArena leaderboard fetch attempt failed", {
          leaderboard: spec.leaderboardId,
          key,
          url: url.toString(),
          ...describeError(error)
        });
      }
    }
  }
  throw new Error(
    `LMArena leaderboard fetch failed: leaderboard=${spec.leaderboardId} tried keys [${spec.fetch.categoryKeys.join(", ")}]; ${attempts.join(" | ")}`
  );
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
  key?: string;
  retryDelayMs: number;
}

/**
 * Fetches one page, retrying transient failures (5xx / timeout). The HF
 * datasets-server intermittently answers 500 "dataset index is loading"
 * while a cold query warms up; a short retry covers it within one fetch.
 */
async function fetchPageText(url: URL, keyLabel: string, transport: TransportOptions): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { text } = await fetchText(url.toString(), transport.requestOptions);
      return text;
    } catch (error) {
      transport.logger?.warn("LMArena leaderboard fetch attempt failed", {
        leaderboard: transport.leaderboard,
        ...(transport.key ? { key: transport.key } : { key: keyLabel }),
        url: url.toString(),
        attempt,
        ...describeError(error)
      });
      if (attempt >= MAX_TRANSPORT_ATTEMPTS || !isTransportError(error)) throw error;
      if (transport.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, transport.retryDelayMs));
      }
    }
  }
}

function isTransportError(error: unknown): boolean {
  if (error instanceof HttpError) return (error.status ?? 0) >= 500;
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError")
  );
}

function collectTop(
  page: { rows: LmArenaRow[]; total: number },
  topN: number,
  spec: LmArenaBoardSpec,
  source: string
): RankedModel[] {
  // The upstream leaderboard can list the same model name as two separate
  // rows (e.g. different harness configurations). Keep the best-ranked row
  // per name so the TOP display shows one line per model.
  const byName = new Map<string, RankedModel>();
  for (const row of page.rows) {
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

function describeAttempt(key: string, url: string, error: unknown): string {
  const detail = describeError(error);
  return `key=${key} url=${url}${detail.status !== undefined ? ` status=${detail.status}` : ""} error=${detail.error}`;
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

function filterUrl(categoryKey: string): URL {
  const url = new URL("https://datasets-server.huggingface.co/filter");
  url.searchParams.set("dataset", DATASET_ID);
  url.searchParams.set("config", "text_style_control");
  url.searchParams.set("split", "latest");
  url.searchParams.set("where", `"category"='${categoryKey}'`);
  url.searchParams.set("offset", "0");
  url.searchParams.set("length", String(PAGE_SIZE));
  return url;
}

function rowsUrl(config: string): URL {
  const url = new URL("https://datasets-server.huggingface.co/rows");
  url.searchParams.set("dataset", DATASET_ID);
  url.searchParams.set("config", config);
  url.searchParams.set("split", "latest");
  url.searchParams.set("offset", "0");
  url.searchParams.set("length", String(PAGE_SIZE));
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
