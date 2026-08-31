import { z } from "zod";
import { fetchText, HttpError, parseJson } from "./http.js";
import type { Logger } from "./logger.js";
import type { ModelPrice } from "./types.js";

/**
 * OpenRouter publishes a public, unauthenticated catalog of models with
 * per-token pricing and context lengths. The bot resolves announcement model
 * ids and leaderboard names against it to answer "出た! → いくら?" at a
 * glance, without an API key or any extra configuration.
 */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** The catalog embeds long descriptions per model; 8 MB leaves headroom. */
const MODELS_MAX_BYTES = 8 * 1024 * 1024;
const MODELS_TIMEOUT_MS = 30_000;
/** Total transport attempts before giving up on the catalog for this run. */
const MAX_TRANSPORT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;
/** Retry backoff as multiples of retryDelayMs: two waits (5s, then 15s). */
const RETRY_BACKOFF_MULTIPLIERS = [1, 3] as const;

/**
 * Maps announcement provider ids to OpenRouter vendor slugs so alert model ids
 * resolve to `${vendor}/${modelId}` first. A provider missing here simply
 * skips vendor-prefixed matching and falls back to HF / bare-slug lookups.
 */
export const PROVIDER_VENDOR_SLUGS: Readonly<Record<string, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  xai: "x-ai",
  mistral: "mistralai",
  deepseek: "deepseek",
  zai: "z-ai",
  qwen: "qwen",
  moonshot: "moonshotai",
  meta: "meta-llama"
};

export interface OpenRouterPricing {
  /** USD per token; undefined when absent or unparseable. */
  promptPerToken?: number;
  completionPerToken?: number;
  /** Both sides present and exactly "0". */
  isFree: boolean;
  /** Either side carries the "-1" variable-pricing marker. */
  isVariable: boolean;
}

export interface OpenRouterModel {
  id: string;
  canonicalSlug?: string;
  huggingFaceId?: string;
  name: string;
  /** Unix seconds; used to prefer the freshest entry on slug collisions. */
  created?: number;
  contextLength?: number;
  pricing: OpenRouterPricing;
  /** Vendor half of `id`, e.g. "google" for "google/gemini-2.5-pro". */
  vendorSlug?: string;
  /** Vendor-stripped normalized id, e.g. "gemini-2.5-pro". */
  bareSlug: string;
}

export interface OpenRouterCatalog {
  readonly models: readonly OpenRouterModel[];
  /** Normalized full ids + canonical slugs + bare slugs + normalized HF ids. */
  readonly bySlug: ReadonlyMap<string, OpenRouterModel>;
  /** Lowercased `hugging_face_id`s (announcement model ids are lowercased too). */
  readonly byHuggingFaceId: ReadonlyMap<string, OpenRouterModel>;
  /** Vendor-tag- and parenthetical-stripped normalized display names. */
  readonly byDisplayName: ReadonlyMap<string, OpenRouterModel>;
}

const pricingSchema = z
  .object({ prompt: z.string(), completion: z.string() })
  .passthrough();

const openRouterModelSchema = z
  .object({
    id: z.string().trim().min(1),
    canonical_slug: z.string().trim().min(1).optional(),
    hugging_face_id: z.string().trim().min(1).nullable().optional(),
    name: z.string().trim().min(1),
    created: z.number().finite().optional(),
    context_length: z.number().int().nonnegative().optional(),
    pricing: pricingSchema
  })
  .passthrough();

const modelsEnvelopeSchema = z
  .object({ data: z.array(z.unknown()).min(1) })
  .passthrough();

/**
 * Parses the models envelope. A single malformed row is dropped instead of
 * killing the whole catalog — one odd entry must not cost every alert and
 * ranking post its prices. Fail-closed is kept at the "no usable rows" level.
 */
export function parseOpenRouterModels(payload: unknown): OpenRouterModel[] {
  const envelope = modelsEnvelopeSchema.parse(payload);
  const models: OpenRouterModel[] = [];
  for (const entry of envelope.data) {
    const parsed = openRouterModelSchema.safeParse(entry);
    if (parsed.success) models.push(toOpenRouterModel(parsed.data));
  }
  if (models.length === 0) {
    throw new Error("OpenRouter model list returned no usable entries");
  }
  return models;
}

type ParsedModelEntry = z.infer<typeof openRouterModelSchema>;

function toOpenRouterModel(entry: ParsedModelEntry): OpenRouterModel {
  const separator = entry.id.indexOf("/");
  return {
    id: entry.id,
    ...(entry.canonical_slug ? { canonicalSlug: entry.canonical_slug } : {}),
    ...(entry.hugging_face_id ? { huggingFaceId: entry.hugging_face_id } : {}),
    name: entry.name,
    ...(entry.created !== undefined ? { created: entry.created } : {}),
    ...(entry.context_length !== undefined ? { contextLength: entry.context_length } : {}),
    pricing: parsePricing(entry.pricing),
    ...(separator === -1 ? {} : { vendorSlug: normalizeSlugKey(entry.id.slice(0, separator)) }),
    bareSlug: bareSlug(entry.id)
  };
}

function parsePricing(pricing: { prompt: string; completion: string }): OpenRouterPricing {
  const prompt = parsePerToken(pricing.prompt);
  const completion = parsePerToken(pricing.completion);
  return {
    ...(prompt !== undefined ? { promptPerToken: prompt } : {}),
    ...(completion !== undefined ? { completionPerToken: completion } : {}),
    isFree: prompt === 0 && completion === 0,
    isVariable: pricing.prompt.trim() === "-1" || pricing.completion.trim() === "-1"
  };
}

function parsePerToken(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Normalizes a model id into an index key: lowercased, any ":variant" suffix
 * dropped (:free / :extended / :batch …), separators collapsed. Interior
 * version dots survive ("gemini-2.5-pro" stays one shape on both sides).
 */
export function normalizeSlugKey(value: string): string {
  const lowered = value.trim().toLowerCase().split(":", 1)[0] ?? "";
  return lowered
    .replace(/\s+/g, "-")
    .replace(/[-_]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** Vendor-stripped normalized slug, e.g. "google/gemini-2.5-pro" → "gemini-2.5-pro". */
export function bareSlug(value: string): string {
  return normalizeSlugKey(value.slice(value.lastIndexOf("/") + 1));
}

/** Drops one trailing -YYYYMMDD marker; query-time only, never in the index. */
function stripDateSuffix(slug: string): string {
  return slug.replace(/-\d{8}$/, "");
}

/**
 * Normalizes a display name into a lookup key: lowercased, parentheticals and
 * a leading "Vendor: " tag removed, whitespace collapsed. Applied to both the
 * catalog names and leaderboard names so "Google: Gemini 2.5 Pro" and
 * "Gemini 2.5 Pro" land on the same key.
 */
function normalizeDisplayName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/^[^:]{1,40}:\s+/, "")
    .trim()
    .replace(/\s+/g, " ");
}

/** "Gemini 2.5 Pro" → "gemini-2.5-pro"; dots survive so version numbers stay intact. */
function slugifyDisplayName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Trailing reasoning-effort markers LMArena appends to leaderboard names
 * ("-high", "(xHigh)"). Safe to drop because effort levels never name a
 * different model — unlike "max"/"next", which are real product tiers.
 */
const EFFORT_TOKENS = new Set(["high", "medium", "low", "xhigh"]);

function stripTrailingEffortTokens(slug: string): string {
  const segments = slug.split("-");
  while (segments.length > 1 && EFFORT_TOKENS.has(segments.at(-1) ?? "")) segments.pop();
  return segments.join("-");
}

/** 1–2 digit runs, optionally already dotted, so "2.4" can absorb "1" → "2.4.1". */
const SHORT_NUMBER_RUN = /^\d{1,2}(\.\d{1,2})*$/;

/**
 * "claude-opus-4-7" → "claude-opus-4.7". LMArena writes versions dash-separated
 * while OpenRouter dots them. Only short digit runs join, so dated slugs
 * ("kimi-k2-0905") and parameter sizes ("30b", "a3b") stay untouched.
 */
function dotJoinNumberRuns(slug: string): string {
  const joined: string[] = [];
  for (const segment of slug.split("-")) {
    const previous = joined.at(-1);
    if (previous !== undefined && SHORT_NUMBER_RUN.test(previous) && SHORT_NUMBER_RUN.test(segment)) {
      joined[joined.length - 1] = `${previous}.${segment}`;
    } else {
      joined.push(segment);
    }
  }
  return joined.join("-");
}

/**
 * Conservative slug variants of a leaderboard name, tried in order as exact
 * catalog lookups: the plain slug, then with parentheticals, trailing effort
 * markers, and dash-split versions progressively normalized. Every variant is
 * still an exact-slug match, so precision guarantees hold; names carrying real
 * product tiers ("kimi-k3-max", "qwen3.8-flash-next") simply stay unmatched.
 */
export function rankingSlugVariants(displayName: string): string[] {
  const withoutParens = displayName.replace(/\([^)]*\)/g, " ");
  const shapes = new Set<string>([
    slugifyDisplayName(displayName),
    slugifyDisplayName(withoutParens)
  ]);
  const variants = new Set<string>();
  for (const shape of shapes) {
    const stripped = stripTrailingEffortTokens(shape);
    for (const candidate of [shape, stripped]) {
      variants.add(candidate);
      const dotted = dotJoinNumberRuns(candidate);
      if (dotted !== candidate) variants.add(dotted);
    }
  }
  return [...variants];
}

export function buildOpenRouterCatalog(models: readonly OpenRouterModel[]): OpenRouterCatalog {
  const bySlug = new Map<string, OpenRouterModel>();
  const byHuggingFaceId = new Map<string, OpenRouterModel>();
  const byDisplayName = new Map<string, OpenRouterModel>();
  for (const model of models) {
    const slugKeys = new Set([
      normalizeSlugKey(model.id),
      ...(model.canonicalSlug ? [normalizeSlugKey(model.canonicalSlug)] : []),
      ...(model.huggingFaceId ? [normalizeSlugKey(model.huggingFaceId), bareSlug(model.huggingFaceId)] : []),
      model.bareSlug
    ]);
    for (const key of slugKeys) putNewest(bySlug, key, model);
    if (model.huggingFaceId) {
      putNewest(byHuggingFaceId, model.huggingFaceId.trim().toLowerCase(), model);
    }
    putNewest(byDisplayName, normalizeDisplayName(model.name), model);
  }
  return { models, bySlug, byHuggingFaceId, byDisplayName };
}

/**
 * Index insertion that keeps the freshest model when several share a key
 * (e.g. dated re-releases); ties break toward the lexicographically smaller
 * id so the choice stays deterministic.
 */
function putNewest(map: Map<string, OpenRouterModel>, key: string, model: OpenRouterModel): void {
  if (key.length === 0) return;
  const existing = map.get(key);
  if (!existing || preferredModel(model, existing)) map.set(key, model);
}

function preferredModel(candidate: OpenRouterModel, existing: OpenRouterModel): boolean {
  if ((candidate.created ?? -1) !== (existing.created ?? -1)) {
    return (candidate.created ?? -1) > (existing.created ?? -1);
  }
  return candidate.id < existing.id;
}

/**
 * Resolves one announcement model id. Order: exact HF repo id →
 * `${vendor}/${modelId}` (with a date-stripped retry) → vendor-guarded bare
 * slug. The guard keeps e.g. a DeepSeek alert from resolving to z-ai/glm-*.
 */
export function matchAlertModelPricing(
  catalog: OpenRouterCatalog,
  providerId: string,
  modelId: string
): OpenRouterModel | undefined {
  const query = modelId.trim().toLowerCase();
  if (query.length === 0) return undefined;
  // Hugging Face organization sources report full repo ids ("qwen/qwen3-..."),
  // which OpenRouter exposes verbatim as hugging_face_id.
  if (query.includes("/")) return catalog.byHuggingFaceId.get(query);
  const vendor = PROVIDER_VENDOR_SLUGS[providerId];
  if (vendor !== undefined) {
    const direct = catalog.bySlug.get(normalizeSlugKey(`${vendor}/${query}`));
    if (direct) return direct;
    const dated = catalog.bySlug.get(normalizeSlugKey(`${vendor}/${stripDateSuffix(query)}`));
    if (dated) return dated;
  }
  const bare = bareSlug(query);
  const bareHit = catalog.bySlug.get(bare);
  if (bareHit && (vendor === undefined || bareHit.vendorSlug === vendor)) return bareHit;
  const datedHit = catalog.bySlug.get(stripDateSuffix(bare));
  if (datedHit && (vendor === undefined || datedHit.vendorSlug === vendor)) return datedHit;
  return undefined;
}

/**
 * Resolves one leaderboard display name. Order: normalized display-name
 * equality → formatting-variant slug equality (rankingSlugVariants) →
 * precision-first token-subset scan. Precision-first means an unmatched name
 * simply shows no price; a wrong one must never show a price.
 */
export function matchRankingModelPricing(
  catalog: OpenRouterCatalog,
  displayName: string
): OpenRouterModel | undefined {
  const name = displayName.trim();
  if (name.length === 0) return undefined;
  const displayHit = catalog.byDisplayName.get(normalizeDisplayName(name));
  if (displayHit) return displayHit;
  for (const slug of rankingSlugVariants(name)) {
    const slugHit = catalog.bySlug.get(slug);
    if (slugHit) return slugHit;
  }
  return matchByTokenSubset(catalog, name);
}

/** Filler words stripped from leaderboard names before subset matching. */
const MODEL_SIDE_STOPWORDS = new Set(["preview", "latest"]);
/**
 * Extra tokens a candidate may carry beyond the queried name: pure qualifiers
 * ("Gemini 3 Pro" → "Gemini 3 Pro Preview"). Tier differentiators ("Lite",
 * "Mini", "Flash" vs "Pro") must never be absorbed this way, or "Gemini 2.5
 * Flash" would price as Flash-Lite.
 */
const CANDIDATE_SIDE_STOPWORDS = new Set(["preview", "latest", "free", "experimental"]);

function tokenizeName(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((token) => token.length > 0)
  );
}

function matchByTokenSubset(
  catalog: OpenRouterCatalog,
  displayName: string
): OpenRouterModel | undefined {
  const modelTokens = new Set(
    [...tokenizeName(displayName)].filter((token) => !MODEL_SIDE_STOPWORDS.has(token))
  );
  // Single-token names are too ambiguous for subset matching; the exact
  // display/slug lookups above already had their chance.
  if (modelTokens.size < 2) return undefined;
  let best: OpenRouterModel | undefined;
  for (const candidate of catalog.models) {
    const candidateTokens = tokenizeName(candidate.name);
    if (candidateTokens.size < 2) continue;
    if (![...modelTokens].every((token) => candidateTokens.has(token))) continue;
    if (!hasAbsorbableExtras(candidate, candidateTokens, modelTokens)) continue;
    if (!best || moreSpecific(candidate, best, modelTokens)) best = candidate;
  }
  return best;
}

/**
 * Whether the candidate's tokens beyond the queried name are only vendor-tag
 * noise ("Google:") or pure qualifiers ("Preview"). Anything else means the
 * candidate is a different tier of the same family, not the same model.
 */
function hasAbsorbableExtras(
  candidate: OpenRouterModel,
  candidateTokens: ReadonlySet<string>,
  modelTokens: ReadonlySet<string>
): boolean {
  for (const token of candidateTokens) {
    if (modelTokens.has(token)) continue;
    if (CANDIDATE_SIDE_STOPWORDS.has(token)) continue;
    if (candidate.vendorSlug !== undefined && tokenizeName(candidate.vendorSlug).has(token)) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Subset survivor ranking: exact token-set equality first, then the smallest
 * candidate token set (the most specific match — "GPT-5.2" over "GPT-5.2
 * Chat"), then the freshest `created`, then the smaller id.
 */
function moreSpecific(
  candidate: OpenRouterModel,
  best: OpenRouterModel,
  modelTokens: ReadonlySet<string>
): boolean {
  const candidateTokens = tokenizeName(candidate.name);
  const bestTokens = tokenizeName(best.name);
  const candidateExact = setEquals(candidateTokens, modelTokens);
  const bestExact = setEquals(bestTokens, modelTokens);
  if (candidateExact !== bestExact) return candidateExact;
  if (candidateTokens.size !== bestTokens.size) return candidateTokens.size < bestTokens.size;
  return preferredModel(candidate, best);
}

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

const USD_PER_MILLION = 1_000_000;
/** Subset matching only needs to beat 2% rounding error, not be exact. */
const MAX_RELATIVE_ERROR = 0.02;

/**
 * Formats a per-token USD price as a per-1M-token string with the least
 * precision that stays within 2% of the value, so cheap models never
 * collapse to "$0" while expensive ones drop the noise ("12" not "12.00").
 */
export function formatUsdPerMillion(perToken: number): string | undefined {
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  if (perToken === 0) return "0";
  const perMillion = perToken * USD_PER_MILLION;
  for (let decimals = 2; decimals < 8; decimals += 1) {
    const fixed = perMillion.toFixed(decimals);
    const rounded = Number(fixed);
    if (rounded === 0) continue;
    if (Math.abs(rounded - perMillion) / perMillion <= MAX_RELATIVE_ERROR) {
      return trimDecimalZeros(fixed);
    }
  }
  return trimDecimalZeros(perMillion.toFixed(8));
}

function trimDecimalZeros(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** Short "$in/$out" form for ranking lines, or "無料" / "変動制". */
export function formatPriceDisplay(model: OpenRouterModel): string | undefined {
  if (model.pricing.isVariable) return "変動制";
  if (model.pricing.isFree) return "無料";
  const input =
    model.pricing.promptPerToken !== undefined
      ? formatUsdPerMillion(model.pricing.promptPerToken)
      : undefined;
  const output =
    model.pricing.completionPerToken !== undefined
      ? formatUsdPerMillion(model.pricing.completionPerToken)
      : undefined;
  if (input !== undefined && output !== undefined) return `$${input}/$${output}`;
  if (input !== undefined) return `$${input}`;
  if (output !== undefined) return `$${output}`;
  return undefined;
}

/** "200000" → "200K", "1000000" → "1M", "131072" → "131K", "4096" → "4.1K". */
export function formatContextLength(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  if (value >= USD_PER_MILLION) return `${trimDecimalZeros((value / USD_PER_MILLION).toFixed(1))}M`;
  if (value >= 1_000) {
    const thousands = value / 1_000;
    const display = thousands < 10 ? trimDecimalZeros(thousands.toFixed(1)) : String(Math.round(thousands));
    return `${display}K`;
  }
  return String(Math.round(value));
}

/**
 * Per-model pricing for an alert, keyed by the exact strings in `modelIds`.
 * Unmatched models simply get no entry, and the embed omits the field when
 * nothing matched.
 */
export function resolveAlertPricing(
  catalog: OpenRouterCatalog,
  providerId: string,
  modelIds: readonly string[]
): Record<string, ModelPrice> {
  const pricing: Record<string, ModelPrice> = {};
  for (const modelId of modelIds) {
    const match = matchAlertModelPricing(catalog, providerId, modelId);
    const priceDisplay = match ? formatPriceDisplay(match) : undefined;
    if (!match || priceDisplay === undefined) continue;
    const contextDisplay = formatContextLength(match.contextLength);
    pricing[modelId] = {
      priceDisplay,
      ...(contextDisplay !== undefined ? { contextDisplay } : {})
    };
  }
  return pricing;
}

/** Short-form prices for ranking lines, keyed by the leaderboard name. */
export function resolveRankingPricing(
  catalog: OpenRouterCatalog,
  names: readonly string[]
): ReadonlyMap<string, string> {
  const prices = new Map<string, string>();
  for (const name of names) {
    const match = matchRankingModelPricing(catalog, name);
    const priceDisplay = match ? formatPriceDisplay(match) : undefined;
    if (priceDisplay !== undefined) prices.set(name, priceDisplay);
  }
  return prices;
}

export interface FetchOpenRouterOptions {
  fetchFn?: typeof globalThis.fetch;
  logger?: Logger;
  /** Base delay for transient (5xx/429/timeout) retries. */
  retryDelayMs?: number;
}

/** Fetches and indexes the OpenRouter catalog with transport-level retries. */
export async function fetchOpenRouterModels(
  options: FetchOpenRouterOptions = {}
): Promise<OpenRouterCatalog> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { text } = await fetchText(OPENROUTER_MODELS_URL, {
        headers: { accept: "application/json" },
        maxBytes: MODELS_MAX_BYTES,
        timeoutMs: MODELS_TIMEOUT_MS,
        fetchFn: options.fetchFn
      });
      return buildOpenRouterCatalog(parseOpenRouterModels(parseJson(text, "openrouter-models")));
    } catch (error) {
      options.logger?.warn("OpenRouter model catalog fetch attempt failed", {
        url: OPENROUTER_MODELS_URL,
        attempt,
        ...describeError(error)
      });
      if (attempt >= MAX_TRANSPORT_ATTEMPTS || !isTransportError(error)) throw error;
      if (retryDelayMs > 0) {
        const multiplier =
          RETRY_BACKOFF_MULTIPLIERS[attempt - 1] ?? RETRY_BACKOFF_MULTIPLIERS.at(-1) ?? 1;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * multiplier));
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
