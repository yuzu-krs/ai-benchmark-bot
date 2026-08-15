import { z } from "zod";
import { fetchText, parseJson } from "./http.js";
import type { RankedModel } from "./types.js";

export type LmArenaBoard = "overall" | "coding";

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
    // The /rows endpoint serving the coding leaderboard (webdev config) has no
    // server-side category filter, so only /filter pages validate this column.
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
}

/**
 * Fetches the current TOP entries of one LMArena board. Boards are fetched
 * independently so a single board failure never blocks the other.
 */
export async function fetchLmArenaTop(
  board: LmArenaBoard,
  options: FetchLmArenaOptions = {}
): Promise<RankedModel[]> {
  const topN = options.topN ?? 10;
  if (!Number.isInteger(topN) || topN < 1 || topN > PAGE_SIZE) {
    throw new Error("topN must be an integer between 1 and 100");
  }
  const url = board === "overall" ? overallUrl() : codingUrl();
  const { text } = await fetchText(url.toString(), {
    headers: {
      accept: "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
    },
    maxBytes: PAGE_MAX_BYTES,
    // HF dataset queries are computed on demand and can exceed the common
    // 30-second source deadline even when the service is healthy.
    timeoutMs: PAGE_TIMEOUT_MS,
    fetchFn: options.fetchFn
  });
  const payload = parseJson(text, `LMArena ${board}`);
  const page =
    board === "overall"
      ? parseLmArenaFilterPage(payload, "overall")
      : parseLmArenaRowsPage(payload);
  if (page.rows.length === 0) {
    throw new Error(`LMArena ${board} returned no rows`);
  }
  // The upstream leaderboard can list the same model name as two separate
  // rows (e.g. different harness configurations). Keep the best-ranked row
  // per name so the TOP display shows one line per model.
  const byName = new Map<string, RankedModel>();
  for (const row of page.rows) {
    const model = toRankedModel(row);
    const existing = byName.get(model.name);
    if (!existing || preferred(model, existing)) byName.set(model.name, model);
  }
  return [...byName.values()]
    .sort((a, b) => a.rank - b.rank || b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, topN);
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

function overallUrl(): URL {
  const url = new URL("https://datasets-server.huggingface.co/filter");
  url.searchParams.set("dataset", DATASET_ID);
  url.searchParams.set("config", "text_style_control");
  url.searchParams.set("split", "latest");
  url.searchParams.set("where", `"category"='overall'`);
  url.searchParams.set("offset", "0");
  url.searchParams.set("length", String(PAGE_SIZE));
  return url;
}

function codingUrl(): URL {
  const url = new URL("https://datasets-server.huggingface.co/rows");
  url.searchParams.set("dataset", DATASET_ID);
  url.searchParams.set("config", "webdev");
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
