import { z } from "zod";
import { fetchText, HttpError, parseJson } from "./http.js";
import type { Logger } from "./logger.js";
import type { RankedModel } from "./types.js";

/**
 * Stable internal board id. Also the state-file key (`aa-<board>.json`), so it
 * must never change once released; source-side identifiers live only in
 * AA_BOARDS below.
 */
export type AaBoard = "intelligence" | "coding";

/** The index columns Artificial Analysis publishes per model evaluation. */
export type AaScoreKey =
  | "artificial_analysis_intelligence_index"
  | "artificial_analysis_coding_index"
  | "artificial_analysis_agentic_index";

export interface AaBoardSpec {
  readonly board: AaBoard;
  /** Identity used in logs, e.g. `aa-intelligence`. */
  readonly leaderboardId: string;
  /** Discord display name, e.g. `AA Intelligence`. */
  readonly displayName: string;
  readonly emoji: string;
  /** Evaluation column this board ranks by. */
  readonly scoreKey: AaScoreKey;
}

/**
 * Board registry. Both boards read the same free-tier model list and differ
 * only in the evaluation column they rank by, so one walk of the list feeds
 * both (see createArtificialAnalysisLoader).
 */
export const AA_BOARDS: Readonly<Record<AaBoard, AaBoardSpec>> = {
  intelligence: {
    board: "intelligence",
    leaderboardId: "aa-intelligence",
    displayName: "AA Intelligence",
    emoji: "🧠",
    scoreKey: "artificial_analysis_intelligence_index"
  },
  coding: {
    board: "coding",
    leaderboardId: "aa-coding",
    displayName: "AA Coding",
    emoji: "🛠️",
    scoreKey: "artificial_analysis_coding_index"
  }
};

/** Free-tier models endpoint; authenticated with the `x-api-key` header. */
export const ARTIFICIAL_ANALYSIS_MODELS_URL =
  "https://artificialanalysis.ai/api/v2/language/models/free";

/**
 * Visible attribution is mandatory under the AA terms of use for every tier,
 * so boards.ts embeds this link whenever an AA board is posted.
 */
export const ARTIFICIAL_ANALYSIS_ATTRIBUTION_URL = "https://artificialanalysis.ai/";

const AA_SCORE_KEYS = [
  "artificial_analysis_intelligence_index",
  "artificial_analysis_coding_index",
  "artificial_analysis_agentic_index"
] as const;

export interface ArtificialAnalysisModel {
  readonly id: string;
  readonly name: string;
  readonly creatorName?: string;
  readonly scores: Readonly<Partial<Record<AaScoreKey, number>>>;
}

export interface ArtificialAnalysisModelList {
  readonly models: readonly ArtificialAnalysisModel[];
  readonly intelligenceIndexVersion?: string;
  readonly tier?: string;
}

export interface ArtificialAnalysisPage extends ArtificialAnalysisModelList {
  readonly pagination: { readonly page: number; readonly hasMore: boolean };
}

// The envelope is strict (data array + pagination.has_more are the load-bearing
// contract), the rows are lenient (every evaluation column may be absent or
// null — roughly 40% of the free tier has no coding index yet). Extra columns
// stay parseable via passthrough but are not carried into the mapped models.
const aaEvaluationsSchema = z
  .object({
    artificial_analysis_intelligence_index: z.number().finite().nullable().optional(),
    artificial_analysis_coding_index: z.number().finite().nullable().optional(),
    artificial_analysis_agentic_index: z.number().finite().nullable().optional()
  })
  .passthrough();

const aaModelSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    model_creator: z
      .object({ name: z.string().trim().min(1) })
      .passthrough()
      .nullable()
      .optional(),
    evaluations: aaEvaluationsSchema.nullable().optional()
  })
  .passthrough();

const aaPaginationSchema = z
  .object({
    page: z.number().int().positive(),
    page_size: z.number().int().positive().optional(),
    total_pages: z.number().int().positive().optional(),
    has_more: z.boolean()
  })
  .passthrough();

const aaPageSchema = z
  .object({
    data: z.array(aaModelSchema),
    // The live API serves this as a number ("4.1" ships as 4.1), older docs
    // as a string — normalize either to the display string, tolerate null.
    intelligence_index_version: z
      .union([z.string().trim().min(1), z.number().finite()])
      .transform((value) => String(value))
      .nullish(),
    tier: z.string().trim().min(1).optional(),
    pagination: aaPaginationSchema
  })
  .passthrough();

type ParsedAaModel = z.infer<typeof aaModelSchema>;
type ParsedAaEvaluations = z.infer<typeof aaEvaluationsSchema>;

/**
 * Parses one page of the free-tier model list. Fails closed on an empty data
 * array — an upstream layout change must never post an empty leaderboard.
 */
export function parseArtificialAnalysisPage(payload: unknown): ArtificialAnalysisPage {
  const page = aaPageSchema.parse(payload);
  if (page.data.length === 0) {
    throw new Error(
      `Artificial Analysis returned an empty data array (page ${page.pagination.page})`
    );
  }
  return {
    models: page.data.map(toArtificialAnalysisModel),
    ...(page.intelligence_index_version
      ? { intelligenceIndexVersion: page.intelligence_index_version }
      : {}),
    ...(page.tier ? { tier: page.tier } : {}),
    pagination: { page: page.pagination.page, hasMore: page.pagination.has_more }
  };
}

function toArtificialAnalysisModel(row: ParsedAaModel): ArtificialAnalysisModel {
  return {
    id: row.id,
    name: row.name,
    ...(row.model_creator?.name ? { creatorName: row.model_creator.name } : {}),
    scores: pickScores(row.evaluations)
  };
}

/** null/absent evaluations mean "not measured upstream": dropped, never 0. */
function pickScores(
  evaluations: ParsedAaEvaluations | null | undefined
): Partial<Record<AaScoreKey, number>> {
  const scores: Partial<Record<AaScoreKey, number>> = {};
  if (!evaluations) return scores;
  for (const key of AA_SCORE_KEYS) {
    const value = evaluations[key];
    if (value !== undefined && value !== null) scores[key] = value;
  }
  return scores;
}

export function collectArtificialAnalysisTop(
  models: readonly ArtificialAnalysisModel[],
  board: AaBoard,
  topN: number,
  source: string = ARTIFICIAL_ANALYSIS_MODELS_URL
): RankedModel[] {
  const spec = AA_BOARDS[board];
  validateTopN(topN, MAX_TOP_N);
  const scored: ScoredModel[] = [];
  for (const model of models) {
    const score = model.scores[spec.scoreKey];
    // Models without this board's index are simply not on the board.
    if (score === undefined) continue;
    if (score < 0 || score > 100) {
      throw new Error(
        `Artificial Analysis ${spec.leaderboardId} (${source}) score for "${model.name}" is ${score}, ` +
          "outside the 0-100 index scale; refusing to rank it"
      );
    }
    scored.push({ model, score });
  }
  // Pages can repeat a model id (re-crawled rows): one id is one model, so
  // keep the higher score and break ties toward the smaller name.
  const byId = new Map<string, ScoredModel>();
  for (const entry of scored) {
    const existing = byId.get(entry.model.id);
    if (!existing || preferredScored(entry, existing)) byId.set(entry.model.id, entry);
  }
  const entries = [...byId.values()]
    .sort((a, b) => b.score - a.score || a.model.name.localeCompare(b.model.name))
    .slice(0, topN)
    .map((entry, index) => toRankedModel(entry.model, entry.score, index + 1));
  if (entries.length === 0) {
    throw new Error(
      `Artificial Analysis ${spec.leaderboardId} (${source}) produced no ranked entries`
    );
  }
  return entries;
}

interface ScoredModel {
  readonly model: ArtificialAnalysisModel;
  readonly score: number;
}

function preferredScored(candidate: ScoredModel, existing: ScoredModel): boolean {
  if (candidate.score !== existing.score) return candidate.score > existing.score;
  return candidate.model.name.localeCompare(existing.model.name) < 0;
}

function toRankedModel(model: ArtificialAnalysisModel, score: number, rank: number): RankedModel {
  return {
    entityKey: model.id,
    name: model.name,
    ...(model.creatorName ? { organization: model.creatorName } : {}),
    rank,
    score,
    scoreDisplay: score.toFixed(1)
  };
}

export interface FetchArtificialAnalysisOptions {
  topN?: number;
  apiKey?: string;
  fetchFn?: typeof globalThis.fetch;
  logger?: Logger;
  /** Delay between retries of transient (5xx/429/timeout) failures. */
  retryDelayMs?: number;
}

/** Upstream serves page_size 200; the free-tier quota makes hoarding pointless. */
const MAX_TOP_N = 200;
/** Each page carries ~200 models with pricing blobs; 8 MB leaves headroom. */
const MODELS_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Safety cap on pages walked per run. The live free tier answers in 4 pages;
 * the cap only exists so a broken has_more can never loop against the quota.
 */
const MAX_PAGES = 8;
/** Total transport attempts per URL before giving up for this run. */
const MAX_TRANSPORT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;
/** Retry backoff as multiples of retryDelayMs: two waits (5s, then 15s). */
const RETRY_BACKOFF_MULTIPLIERS = [1, 3] as const;

/**
 * Fetches the current TOP entries of one AA board. Both boards can share a
 * single fetched model list via createArtificialAnalysisLoader, keeping a full
 * run within MAX_PAGES requests of the free-tier quota.
 */
export async function fetchArtificialAnalysisTop(
  board: AaBoard,
  options: FetchArtificialAnalysisOptions = {}
): Promise<RankedModel[]> {
  const spec = AA_BOARDS[board];
  const topN = options.topN ?? 10;
  validateTopN(topN, MAX_TOP_N);
  const list = await fetchModelList(buildTransport(spec.leaderboardId, options));
  return collectArtificialAnalysisTop(list.models, board, topN, ARTIFICIAL_ANALYSIS_MODELS_URL);
}

/**
 * Lazily fetches and memoizes the whole free-tier model list. Both AA boards
 * share one instance: load() starts at most one walk regardless of how often
 * it is called, and the rejection is memoized too, so a failed walk fails both
 * boards identically instead of doubling the quota cost.
 */
export function createArtificialAnalysisLoader(options: FetchArtificialAnalysisOptions = {}): {
  load: () => Promise<ArtificialAnalysisModelList>;
} {
  let promise: Promise<ArtificialAnalysisModelList> | undefined;
  return {
    load() {
      // Deferred through Promise.resolve() so even a synchronous setup failure
      // (missing key) surfaces as a memoized rejection, never a thrown load().
      promise ??= Promise.resolve().then(() => fetchModelList(buildTransport("aa", options)));
      return promise;
    }
  };
}

interface PageFetchTransport {
  requestOptions: {
    headers: Record<string, string>;
    maxBytes: number;
    fetchFn?: typeof globalThis.fetch;
  };
  logger?: Logger;
  leaderboard: string;
  retryDelayMs: number;
}

function buildTransport(
  leaderboard: string,
  options: FetchArtificialAnalysisOptions
): PageFetchTransport {
  // Checked before any request so a missing key costs zero fetches.
  if (!options.apiKey) {
    throw new Error("Artificial Analysis requires an API key; set AA_API_KEY");
  }
  return {
    requestOptions: {
      headers: { accept: "application/json", "x-api-key": options.apiKey },
      maxBytes: MODELS_MAX_BYTES,
      fetchFn: options.fetchFn
    },
    logger: options.logger,
    leaderboard,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  };
}

/**
 * Walks every page of the free-tier model list. The first request carries no
 * page parameter (that is the documented page-1 entry point); deeper pages
 * follow the `pagination.page + 1` cursor from each response. Fails closed on
 * a has_more that outlives the page cap, a page number that stops advancing,
 * and (via the parser) empty data.
 */
async function fetchModelList(transport: PageFetchTransport): Promise<ArtificialAnalysisModelList> {
  const collected: ArtificialAnalysisModel[] = [];
  let intelligenceIndexVersion: string | undefined;
  let tier: string | undefined;
  // undefined = first request, sent without a page parameter.
  let requestedPage: number | undefined;
  for (let pagesFetched = 1; ; pagesFetched += 1) {
    const url = modelsPageUrl(requestedPage);
    const text = await fetchPageText(url, transport);
    const page = parseArtificialAnalysisPage(parseJson(text, transport.leaderboard));
    // The server must move forward every round: answering an earlier page
    // than the one requested means the cursor is being ignored and deeper
    // requests would only collect duplicates of what is already in hand.
    if (requestedPage !== undefined && page.pagination.page < requestedPage) {
      throw new Error(
        `Artificial Analysis ${transport.leaderboard} pagination did not advance ` +
          `(requested page ${requestedPage}, got page ${page.pagination.page}); aborting the walk`
      );
    }
    collected.push(...page.models);
    intelligenceIndexVersion ??= page.intelligenceIndexVersion;
    tier ??= page.tier;
    if (!page.pagination.hasMore) {
      return {
        models: collected,
        ...(intelligenceIndexVersion ? { intelligenceIndexVersion } : {}),
        ...(tier ? { tier } : {})
      };
    }
    if (pagesFetched >= MAX_PAGES) {
      throw new Error(
        `Artificial Analysis ${transport.leaderboard} still reports has_more after ${MAX_PAGES} pages; ` +
          "refusing to serve a truncated board"
      );
    }
    requestedPage = page.pagination.page + 1;
  }
}

function modelsPageUrl(page: number | undefined): URL {
  const url = new URL(ARTIFICIAL_ANALYSIS_MODELS_URL);
  if (page !== undefined) url.searchParams.set("page", String(page));
  return url;
}

/**
 * Fetches one URL, retrying transient failures (5xx / 429 / timeout) with
 * growing delays. Retry-After is deliberately not honored here because
 * fetchText does not expose response headers, so only the fixed backoff below
 * is available.
 */
async function fetchPageText(url: URL, transport: PageFetchTransport): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { text } = await fetchText(url.toString(), transport.requestOptions);
      return text;
    } catch (error) {
      transport.logger?.warn("Artificial Analysis fetch attempt failed", {
        leaderboard: transport.leaderboard,
        url: url.toString(),
        attempt,
        ...describeError(error)
      });
      // A rejected key is a configuration error, not an outage: fail
      // immediately instead of spending quota on doomed retries.
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        throw new Error(
          `Artificial Analysis rejected the API key (HTTP ${error.status}); check AA_API_KEY`,
          { cause: error }
        );
      }
      if (attempt >= MAX_TRANSPORT_ATTEMPTS || !isTransportError(error)) throw error;
      if (transport.retryDelayMs > 0) {
        const multiplier =
          RETRY_BACKOFF_MULTIPLIERS[attempt - 1] ?? RETRY_BACKOFF_MULTIPLIERS.at(-1) ?? 1;
        await new Promise((resolve) => setTimeout(resolve, transport.retryDelayMs * multiplier));
      }
    }
  }
}

function validateTopN(topN: number, max: number): void {
  if (!Number.isInteger(topN) || topN < 1 || topN > max) {
    throw new Error(`topN must be an integer between 1 and ${max}`);
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
