import { describe, expect, it } from "vitest";
import {
  OPENROUTER_MODELS_URL,
  bareSlug,
  buildOpenRouterCatalog,
  fetchOpenRouterModels,
  formatContextLength,
  formatPriceDisplay,
  formatUsdPerMillion,
  matchAlertModelPricing,
  matchRankingModelPricing,
  normalizeSlugKey,
  parseOpenRouterModels,
  resolveAlertPricing
} from "../src/openrouter.js";
import type { OpenRouterCatalog } from "../src/openrouter.js";

interface ModelSpec {
  id: string;
  name: string;
  canonicalSlug?: string;
  huggingFaceId?: string | null;
  created?: number;
  contextLength?: number;
  prompt?: string;
  completion?: string;
}

function rawEntry(spec: ModelSpec): Record<string, unknown> {
  return {
    id: spec.id,
    name: spec.name,
    ...(spec.canonicalSlug ? { canonical_slug: spec.canonicalSlug } : {}),
    hugging_face_id: spec.huggingFaceId ?? null,
    ...(spec.created !== undefined ? { created: spec.created } : {}),
    ...(spec.contextLength !== undefined ? { context_length: spec.contextLength } : {}),
    pricing: { prompt: spec.prompt ?? "0", completion: spec.completion ?? "0" },
    // Unknown columns must never break parsing.
    architecture: { modality: "text->text" }
  };
}

function rawPayload(models: ModelSpec[]): unknown {
  return { data: models.map(rawEntry) };
}

function buildCatalog(models: ModelSpec[]): OpenRouterCatalog {
  return buildOpenRouterCatalog(parseOpenRouterModels(rawPayload(models)));
}

const CATALOG = buildCatalog([
  { id: "openai/gpt-5.2", name: "OpenAI: GPT-5.2", created: 1000, contextLength: 400_000, prompt: "0.00000125", completion: "0.00001" },
  { id: "openai/gpt-5.2:free", name: "OpenAI: GPT-5.2 (free)", created: 900, prompt: "0", completion: "0" },
  { id: "openai/gpt-5", name: "OpenAI: GPT-5", created: 500, contextLength: 128_000, prompt: "0.00000125", completion: "0.00001" },
  { id: "google/gemini-2.5-pro", name: "Google: Gemini 2.5 Pro", created: 600, contextLength: 1_000_000, prompt: "0.00000125", completion: "0.00001" },
  { id: "google/gemini-2.5-flash-lite", name: "Google: Gemini 2.5 Flash-Lite", created: 620, prompt: "0.0000003", completion: "0.0000025" },
  { id: "google/gemini-3-pro-preview", name: "Google: Gemini 3 Pro Preview", created: 900, contextLength: 1_048_576, prompt: "0.000002", completion: "0.000012" },
  { id: "deepseek/deepseek-chat", name: "DeepSeek: DeepSeek Chat", created: 400, prompt: "0.00000028", completion: "0.00000042" },
  { id: "z-ai/glm-5", name: "Z.AI: GLM-5", created: 800, contextLength: 200_000, prompt: "0", completion: "0" },
  { id: "anthropic/claude-opus-4.5", name: "Anthropic: Claude Opus 4.5 (Nov 2026)", created: 700, contextLength: 200_000, prompt: "-1", completion: "0.00005" },
  { id: "moonshotai/kimi-k2.5", name: "Moonshot AI: Kimi K2.5", canonicalSlug: "moonshotai/kimi-k2.5-20260826", created: 850, contextLength: 256_000, prompt: "0.0000006", completion: "0.0000025" },
  { id: "x-ai/grok-4", name: "xAI: Grok 4", created: 650, prompt: "0.000003", completion: "0.000015" },
  { id: "mistralai/mistral-large", name: "Mistral: Mistral Large", created: 300, prompt: "0.000002", completion: "0.000006" },
  { id: "meta-llama/llama-4-maverick", name: "Meta: Llama 4 Maverick", created: 350, prompt: "0.00000022", completion: "0.00000088" },
  {
    id: "qwen/qwen3-next-80b-a3b-instruct",
    name: "Qwen: Qwen3 Next 80B A3B Instruct",
    huggingFaceId: "Qwen/Qwen3-Next-80B-A3B-Instruct",
    created: 750,
    contextLength: 1_000_000,
    prompt: "0.00000015",
    completion: "0.0000012"
  }
]);

function statusResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("OpenRouter model list parsing", () => {
  it("parses prices, variants, and unknown fields", () => {
    const parsed = parseOpenRouterModels(
      rawPayload([
        { id: "openai/gpt-5.2", name: "OpenAI: GPT-5.2", created: 1000, contextLength: 400_000, prompt: "0.00000125", completion: "0.00001" }
      ])
    );
    expect(parsed).toHaveLength(1);
    const model = parsed[0]!;
    expect(model.id).toBe("openai/gpt-5.2");
    expect(model.vendorSlug).toBe("openai");
    expect(model.bareSlug).toBe("gpt-5.2");
    expect(model.created).toBe(1000);
    expect(model.contextLength).toBe(400_000);
    expect(model.pricing.promptPerToken).toBe(0.00000125);
    expect(model.pricing.completionPerToken).toBe(0.00001);
    expect(model.pricing.isFree).toBe(false);
    expect(model.pricing.isVariable).toBe(false);
  });

  it("marks free and variable pricing without inventing numbers", () => {
    const parsed = parseOpenRouterModels(
      rawPayload([
        { id: "a/free-model", name: "A: Free Model", prompt: "0", completion: "0" },
        { id: "b/variable-model", name: "B: Variable Model", prompt: "-1", completion: "0.00005" }
      ])
    );
    expect(parsed[0]?.pricing.isFree).toBe(true);
    expect(parsed[0]?.pricing.promptPerToken).toBe(0);
    expect(parsed[1]?.pricing.isVariable).toBe(true);
    expect(parsed[1]?.pricing.promptPerToken).toBeUndefined();
  });

  it("treats non-numeric pricing as unknown instead of throwing", () => {
    const parsed = parseOpenRouterModels(
      rawPayload([{ id: "a/broken", name: "A: Broken", prompt: "ask", completion: "0.00001" }])
    );
    expect(parsed[0]?.pricing.promptPerToken).toBeUndefined();
    expect(parsed[0]?.pricing.completionPerToken).toBe(0.00001);
  });

  it("drops malformed entries and only fails when nothing survives", () => {
    const mixed = parseOpenRouterModels({
      data: [
        rawEntry({ id: "a/good", name: "A: Good" }),
        { id: "", name: "missing id" },
        { id: "a/no-pricing", name: "A: No Pricing" },
        "not-an-object"
      ]
    });
    expect(mixed.map((model) => model.id)).toEqual(["a/good"]);
    expect(() => parseOpenRouterModels({ data: [{ id: "", name: "broken" }] })).toThrow(
      /no usable entries/
    );
  });

  it("throws when the data envelope is missing or empty", () => {
    expect(() => parseOpenRouterModels({})).toThrow();
    expect(() => parseOpenRouterModels({ data: [] })).toThrow();
  });
});

describe("OpenRouter catalog indexes", () => {
  it("exposes full ids, canonical slugs, bare slugs, and HF ids", () => {
    expect(CATALOG.bySlug.get(normalizeSlugKey("openai/gpt-5.2"))?.id).toBe("openai/gpt-5.2");
    expect(CATALOG.bySlug.get("moonshotai/kimi-k2.5-20260826")?.id).toBe("moonshotai/kimi-k2.5");
    expect(CATALOG.bySlug.get(bareSlug("google/gemini-2.5-pro"))?.id).toBe("google/gemini-2.5-pro");
    expect(CATALOG.byHuggingFaceId.get("qwen/qwen3-next-80b-a3b-instruct")?.id).toBe(
      "qwen/qwen3-next-80b-a3b-instruct"
    );
    expect(CATALOG.byDisplayName.get("gemini 2.5 pro")?.id).toBe("google/gemini-2.5-pro");
  });

  it("keeps the newest model when a slug collides", () => {
    const catalog = buildCatalog([
      { id: "vendor/model", name: "Vendor: Model", created: 100, prompt: "0.000001", completion: "0.000002" },
      { id: "vendor/model:free", name: "Vendor: Model (free)", created: 200, prompt: "0", completion: "0" }
    ]);
    // The ":free" suffix normalizes away, so both models claim the same key.
    expect(catalog.bySlug.get("vendor/model")?.id).toBe("vendor/model:free");
    expect(catalog.byDisplayName.get("model")?.id).toBe("vendor/model:free");
  });

  it("keeps version dots intact across normalization", () => {
    expect(normalizeSlugKey("Google/Gemini-2.5 Pro:free")).toBe("google/gemini-2.5-pro");
    expect(bareSlug("z-ai/glm-4.6")).toBe("glm-4.6");
  });
});

describe("price formatting", () => {
  it("formats per-million USD with minimal but faithful precision", () => {
    expect(formatUsdPerMillion(0.000012)).toBe("12");
    expect(formatUsdPerMillion(0.0000012)).toBe("1.2");
    expect(formatUsdPerMillion(0.00000125)).toBe("1.25");
    expect(formatUsdPerMillion(0.00000015)).toBe("0.15");
    expect(formatUsdPerMillion(0.000000075)).toBe("0.075");
    expect(formatUsdPerMillion(0.0000002)).toBe("0.2");
    expect(formatUsdPerMillion(0.0000000002)).toBe("0.0002");
    expect(formatUsdPerMillion(0)).toBe("0");
    expect(formatUsdPerMillion(-1)).toBeUndefined();
    expect(formatUsdPerMillion(Number.NaN)).toBeUndefined();
  });

  it("renders free, variable, and partial prices", () => {
    const price = (spec: ModelSpec) => formatPriceDisplay(parseOpenRouterModels(rawPayload([spec]))[0]!);
    expect(price({ id: "a/m", name: "A: M", prompt: "0.00000125", completion: "0.00001" })).toBe("$1.25/$10");
    expect(price({ id: "a/m", name: "A: M", prompt: "0", completion: "0" })).toBe("無料");
    expect(price({ id: "a/m", name: "A: M", prompt: "-1", completion: "0.00001" })).toBe("変動制");
    expect(price({ id: "a/m", name: "A: M", prompt: "0.000005", completion: "ask" })).toBe("$5");
    expect(price({ id: "a/m", name: "A: M", prompt: "ask", completion: "ask" })).toBeUndefined();
  });

  it("renders context lengths compactly", () => {
    expect(formatContextLength(200_000)).toBe("200K");
    expect(formatContextLength(1_000_000)).toBe("1M");
    expect(formatContextLength(1_048_576)).toBe("1M");
    expect(formatContextLength(131_072)).toBe("131K");
    expect(formatContextLength(4_096)).toBe("4.1K");
    expect(formatContextLength(undefined)).toBeUndefined();
    expect(formatContextLength(0)).toBeUndefined();
  });
});

describe("alert model pricing matching", () => {
  it("resolves full HF repo ids case-insensitively", () => {
    expect(matchAlertModelPricing(CATALOG, "qwen", "qwen/qwen3-next-80b-a3b-instruct")?.id).toBe(
      "qwen/qwen3-next-80b-a3b-instruct"
    );
  });

  it("maps every announcement provider to its OpenRouter vendor", () => {
    const cases = [
      { provider: "openai", modelId: "gpt-5.2", expected: "openai/gpt-5.2" },
      { provider: "xai", modelId: "grok-4", expected: "x-ai/grok-4" },
      { provider: "mistral", modelId: "mistral-large", expected: "mistralai/mistral-large" },
      { provider: "zai", modelId: "glm-5", expected: "z-ai/glm-5" },
      { provider: "moonshot", modelId: "kimi-k2.5", expected: "moonshotai/kimi-k2.5" },
      { provider: "meta", modelId: "llama-4-maverick", expected: "meta-llama/llama-4-maverick" }
    ];
    for (const { provider, modelId, expected } of cases) {
      expect(matchAlertModelPricing(CATALOG, provider, modelId)?.id).toBe(expected);
    }
  });

  it("strips date suffixes when the exact id is absent", () => {
    expect(matchAlertModelPricing(CATALOG, "moonshot", "kimi-k2.5-20260826")?.id).toBe(
      "moonshotai/kimi-k2.5"
    );
  });

  it("resolves through :free variants without showing them as the model", () => {
    expect(matchAlertModelPricing(CATALOG, "openai", "gpt-5.2")?.id).toBe("openai/gpt-5.2");
    const freeOnly = buildCatalog([
      { id: "deepseek/deepseek-chat:free", name: "DeepSeek: Chat (free)", prompt: "0", completion: "0" }
    ]);
    expect(matchAlertModelPricing(freeOnly, "deepseek", "deepseek-chat")?.id).toBe(
      "deepseek/deepseek-chat:free"
    );
  });

  it("never crosses vendor boundaries on bare slugs", () => {
    expect(matchAlertModelPricing(CATALOG, "deepseek", "glm-5")).toBeUndefined();
    expect(matchAlertModelPricing(CATALOG, "deepseek", "gpt-5.2")).toBeUndefined();
  });

  it("falls back to an unguarded bare slug for unknown providers", () => {
    expect(matchAlertModelPricing(CATALOG, "perplexity", "glm-5")?.id).toBe("z-ai/glm-5");
  });

  it("attaches context lengths only to matched models", () => {
    const pricing = resolveAlertPricing(CATALOG, "openai", ["gpt-5.2", "totally-unknown"]);
    expect(pricing["gpt-5.2"]).toEqual({ priceDisplay: "$1.25/$10", contextDisplay: "400K" });
    expect(pricing["totally-unknown"]).toBeUndefined();
    expect(resolveAlertPricing(CATALOG, "zai", ["glm-5"])).toEqual({
      "glm-5": { priceDisplay: "無料", contextDisplay: "200K" }
    });
  });
});

describe("ranking name pricing matching", () => {
  it("matches leaderboard names after normalization", () => {
    expect(matchRankingModelPricing(CATALOG, "Gemini 2.5 Pro")?.id).toBe("google/gemini-2.5-pro");
    expect(matchRankingModelPricing(CATALOG, "Claude Opus 4.5")?.id).toBe(
      "anthropic/claude-opus-4.5"
    );
    expect(matchRankingModelPricing(CATALOG, "Kimi K2.5")?.id).toBe("moonshotai/kimi-k2.5");
  });

  it("matches preview-suffixed models through token subsets", () => {
    expect(matchRankingModelPricing(CATALOG, "Gemini 3 Pro")?.id).toBe("google/gemini-3-pro-preview");
    expect(matchRankingModelPricing(CATALOG, "Gemini 3 Pro Preview")?.id).toBe(
      "google/gemini-3-pro-preview"
    );
  });

  it("never matches across model tiers", () => {
    const tiers = buildCatalog([
      { id: "google/gemini-2.5-flash-lite", name: "Google: Gemini 2.5 Flash-Lite", prompt: "0.0000003", completion: "0.0000025" }
    ]);
    expect(matchRankingModelPricing(tiers, "Gemini 2.5 Flash")).toBeUndefined();
    expect(matchRankingModelPricing(tiers, "Gemini 3 Pro")).toBeUndefined();
    const variants = buildCatalog([
      { id: "openai/gpt-5.2-thinking", name: "OpenAI: GPT-5.2 Thinking", prompt: "0.000001", completion: "0.00001" },
      { id: "openai/gpt-5.2-thinking-lite", name: "OpenAI: GPT-5.2 Thinking Lite", prompt: "0.0000005", completion: "0.000005" }
    ]);
    expect(matchRankingModelPricing(variants, "GPT-5.2 Thinking")?.id).toBe(
      "openai/gpt-5.2-thinking"
    );
  });

  it("returns nothing for unknown or ambiguous names", () => {
    expect(matchRankingModelPricing(CATALOG, "nonexistent-model")).toBeUndefined();
    expect(matchRankingModelPricing(CATALOG, "o3")).toBeUndefined();
    expect(matchRankingModelPricing(CATALOG, "")).toBeUndefined();
  });
});

describe("fetchOpenRouterModels", () => {
  it("fetches the public catalog with retries on transient failures", async () => {
    const captured: string[] = [];
    const headers: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push(String(input));
      headers.push(String(new Headers(init?.headers).get("accept")));
      if (captured.length === 1) return statusResponse(500, { error: "boom" });
      return statusResponse(200, rawPayload([{ id: "a/b", name: "A: B" }]));
    }) as typeof fetch;

    const catalog = await fetchOpenRouterModels({ fetchFn, retryDelayMs: 0 });
    expect(catalog.models.map((model) => model.id)).toEqual(["a/b"]);
    expect(captured).toEqual([OPENROUTER_MODELS_URL, OPENROUTER_MODELS_URL]);
    expect(headers.every((value) => value === "application/json")).toBe(true);
  });

  it("gives up after three transport attempts", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return statusResponse(500, { error: "boom" });
    }) as typeof fetch;

    await expect(fetchOpenRouterModels({ fetchFn, retryDelayMs: 0 })).rejects.toThrow(/500/);
    expect(calls).toBe(3);
  });

  it("does not retry parse failures", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return statusResponse(200, { data: [] });
    }) as typeof fetch;

    await expect(fetchOpenRouterModels({ fetchFn, retryDelayMs: 0 })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
