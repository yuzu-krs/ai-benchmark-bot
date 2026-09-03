import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDailyRanking } from "../src/ranking.js";
import { StateStore } from "../src/state.js";
import type { Logger } from "../src/logger.js";
import type { EmbedPayload, RankedModel } from "../src/types.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function boardPage(names: string[]): unknown {
  return {
    rows: names.map((name, index) => ({
      row_idx: index,
      row: {
        model_name: name,
        organization: "Example AI",
        rating: 1500 - index * 7.3,
        rank: index + 1,
        category: "overall",
        leaderboard_publish_date: "2026-08-12"
      },
      truncated_cells: []
    })),
    num_rows_total: names.length,
    num_rows_per_page: 100,
    partial: false
  };
}

/** One AA model row: scores are null when the index was not measured. */
function aaModel(
  id: string,
  name: string,
  scores: { intelligence?: number; coding?: number }
): unknown {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9.]+/g, "-"),
    model_creator: { id: "creator-1", name: "Example AI" },
    evaluations: {
      artificial_analysis_intelligence_index: scores.intelligence ?? null,
      artificial_analysis_coding_index: scores.coding ?? null,
      artificial_analysis_agentic_index: null
    }
  };
}

function aaEnvelope(models: unknown[]): unknown {
  return {
    tier: "free",
    intelligence_index_version: "4.1",
    pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
    data: models
  };
}

/** AA boards share one list: both boards read the same envelope. */
const DEFAULT_AA_MODELS = [
  aaModel("id-alpha", "aa-alpha", { intelligence: 65.7 }),
  aaModel("id-beta", "aa-beta", { intelligence: 60.1 }),
  aaModel("id-code-1", "aa-code-1", { coding: 71.2 }),
  aaModel("id-code-2", "aa-code-2", { coding: 66.6 })
];

type ResponseSlot = "lmarena-overall" | "lmarena-coding" | "openrouter" | "aa";

interface Harness {
  store: StateStore;
  sent: EmbedPayload[];
  send: (embed: EmbedPayload) => Promise<void>;
  fetchFn: typeof fetch;
  /** Every requested URL, in order, for "never contacted" assertions. */
  requests: string[];
  setResponse: (slot: ResponseSlot, response: () => Promise<Response>) => void;
}

function jsonOk(payload: unknown): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
}

function openRouterResponse(models: Array<Record<string, unknown>>): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ data: models }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
}

/** A catalog entry that matches none of the leaderboard fixture names. */
const UNRELATED_CATALOG_MODEL = {
  id: "unrelated/vendor-model",
  name: "Vendor: Unrelated Model",
  hugging_face_id: null,
  created: 1,
  context_length: 8192,
  pricing: { prompt: "0.0000012", completion: "0.000012" }
};

function createHarness(overallNames: string[], codingNames: string[]): Harness {
  const store = new StateStore(mkdtempSync(join(tmpdir(), "ranking-")));
  const sent: EmbedPayload[] = [];
  const requests: string[] = [];
  const responses = new Map<ResponseSlot, () => Promise<Response>>([
    ["lmarena-overall", jsonOk(boardPage(overallNames))],
    ["lmarena-coding", jsonOk(boardPage(codingNames))],
    ["aa", jsonOk(aaEnvelope(DEFAULT_AA_MODELS))],
    ["openrouter", () => openRouterResponse([UNRELATED_CATALOG_MODEL])]
  ]);
  return {
    store,
    sent,
    requests,
    send: async (embed) => {
      sent.push(embed);
    },
    fetchFn: (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      let slot: ResponseSlot;
      if (url.includes("openrouter.ai")) slot = "openrouter";
      else if (url.includes("artificialanalysis.ai")) slot = "aa";
      else slot = url.includes("config=text_style_control") ? "lmarena-overall" : "lmarena-coding";
      const responder = responses.get(slot);
      if (!responder) throw new Error(`unexpected url: ${url}`);
      return responder();
    }) as typeof fetch,
    setResponse: (slot, response) => responses.set(slot, response)
  };
}

const fixedNow = () => new Date("2026-08-16T07:00:30.000Z");

interface RunOptions {
  readonly aaApiKey?: string;
}

function runWith(harness: Harness, options: RunOptions = {}): ReturnType<typeof runDailyRanking> {
  return runDailyRanking({
    timeZone: "Asia/Tokyo",
    store: harness.store,
    logger,
    send: harness.send,
    fetchFn: harness.fetchFn,
    ...(options.aaApiKey ? { aaApiKey: options.aaApiKey } : {}),
    now: fixedNow,
    retryDelayMs: 0
  });
}

function previousEntries(names: string[], startRank = 1): RankedModel[] {
  return names.map((name, index) => ({
    entityKey: name,
    name,
    rank: startRank + index,
    score: 1400,
    scoreDisplay: "1400"
  }));
}

describe("runDailyRanking", () => {
  it("posts the configured boards in order, saves snapshots, and records the day", async () => {
    const harness = createHarness(["model-a", "model-b"], ["model-x", "model-y"]);
    const result = await runWith(harness);

    expect(result).toEqual({
      dateKey: "2026-08-16",
      posted: true,
      boards: {
        "lmarena-overall": "ok",
        "lmarena-coding": "ok"
      },
      skipped: ["aa-intelligence", "aa-coding"]
    });
    expect(harness.sent).toHaveLength(1);
    const embed = harness.sent[0]!;
    expect(embed.fields.map((field) => field.name)).toEqual([
      "🏆 LMArena Overall",
      "💻 LMArena Coding"
    ]);
    expect(embed.fields[0]?.value).toContain("🥇 1. model-a");
    expect(harness.store.loadRanking("lmarena-overall")?.entries.map((entry) => entry.name)).toEqual(
      ["model-a", "model-b"]
    );
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });

  it("renders four boards, saves every snapshot, and attributes AA in the footer", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    const result = await runWith(harness, { aaApiKey: "aa_test_key" });

    expect(result).toEqual({
      dateKey: "2026-08-16",
      posted: true,
      boards: {
        "lmarena-overall": "ok",
        "lmarena-coding": "ok",
        "aa-intelligence": "ok",
        "aa-coding": "ok"
      },
      skipped: []
    });
    expect(harness.sent).toHaveLength(1);
    const embed = harness.sent[0]!;
    expect(embed.fields.map((field) => field.name)).toEqual([
      "🏆 LMArena Overall",
      "💻 LMArena Coding",
      "🧠 AA Intelligence",
      "🛠️ AA Coding"
    ]);
    // Both AA boards share the memoized loader: the whole run costs one call.
    expect(harness.requests.filter((url) => url.includes("artificialanalysis.ai"))).toHaveLength(1);
    // Source credits live in the footer only; the description stays date + updated.
    expect(embed.description).not.toContain("データ:");
    expect(embed.footer?.text).toContain("🧠 AA指数 0-100");
    expect(embed.footer?.text).toContain("データ: artificialanalysis.ai");
    expect(harness.store.loadRanking("aa-intelligence")?.entries.map((entry) => entry.name)).toEqual(
      ["aa-alpha", "aa-beta"]
    );
    expect(harness.store.loadRanking("aa-intelligence")?.entries[0]?.scoreDisplay).toBe("65.7");
    expect(harness.store.loadRanking("aa-coding")?.entries.map((entry) => entry.name)).toEqual([
      "aa-code-1",
      "aa-code-2"
    ]);
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });

  it("omits the AA boards entirely without a key and never contacts AA", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    await runWith(harness);

    const embed = harness.sent[0]!;
    // Only the two LMArena boards; the AA boards are absent, not failed.
    expect(embed.fields.map((field) => field.name)).toEqual([
      "🏆 LMArena Overall",
      "💻 LMArena Coding"
    ]);
    // No second source ran, so the footer carries no credit and no AA legend.
    expect(embed.description).not.toContain("データ:");
    expect(embed.footer?.text).not.toContain("データ:");
    expect(embed.footer?.text).not.toContain("AA指数");
    expect(embed.fields[0]?.value.endsWith(`\n${String.fromCodePoint(0x200b)}`)).toBe(false);
    expect(embed.fields[1]?.value.endsWith(`\n${String.fromCodePoint(0x200b)}`)).toBe(false);
    expect(harness.requests.filter((url) => url.includes("artificialanalysis.ai"))).toHaveLength(0);
    expect(harness.store.loadRanking("aa-intelligence")).toBeUndefined();
  });

  it("shows deltas against the previous snapshot and marks new entries", async () => {
    const harness = createHarness(["model-a", "model-new"], ["model-x"]);
    harness.store.saveRanking(
      "lmarena-overall",
      previousEntries(["model-old", "model-a"]),
      "2026-08-15T22:00:00.000Z"
    );
    await runWith(harness);
    const value = harness.sent[0]!.fields[0]!.value;
    expect(value).toContain("1. model-a");
    expect(value).toContain("⬆️ +1");
    expect(value).toContain("2. model-new");
    expect(value).toContain("🆕 NEW");
  });

  it("keeps posting when only one board fails, and preserves that board's snapshot", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    harness.store.saveRanking(
      "lmarena-coding",
      previousEntries(["model-x"]),
      "2026-08-15T22:00:00.000Z"
    );
    harness.setResponse(
      "lmarena-coding",
      () => Promise.resolve(new Response("server error", { status: 500 }))
    );

    const result = await runWith(harness);

    expect(result.boards).toEqual({
      "lmarena-overall": "ok",
      "lmarena-coding": "failed"
    });
    const embed = harness.sent[0]!;
    expect(embed.fields[0]?.value).toContain("model-a");
    expect(embed.fields[1]?.value).toBe("⚠️ ランキングを取得できませんでした。");
    // The previous coding snapshot survives untouched for the next comparison.
    expect(harness.store.loadRanking("lmarena-coding")?.savedAt).toBe("2026-08-15T22:00:00.000Z");
    expect(harness.store.loadRanking("lmarena-overall")?.entries[0]?.name).toBe("model-a");
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });

  it("keeps LMArena alive when every AA fetch fails", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    harness.store.saveRanking(
      "aa-intelligence",
      previousEntries(["aa-alpha"]),
      "2026-08-15T22:00:00.000Z"
    );
    harness.setResponse("aa", () => Promise.resolve(new Response("denied", { status: 401 })));

    const result = await runWith(harness, { aaApiKey: "aa_test_key" });

    expect(result.boards).toEqual({
      "lmarena-overall": "ok",
      "lmarena-coding": "ok",
      "aa-intelligence": "failed",
      "aa-coding": "failed"
    });
    const embed = harness.sent[0]!;
    expect(embed.fields[1]?.value).toBe("🥇 1. model-x · 1500 ➖");
    expect(embed.fields[2]?.value).toBe("⚠️ ランキングを取得できませんでした。");
    expect(embed.fields[3]?.value).toBe("⚠️ ランキングを取得できませんでした。");
    // No AA success means no AA credit or legend in the footer.
    expect(embed.description).not.toContain("データ:");
    expect(embed.footer?.text).not.toContain("データ:");
    expect(embed.footer?.text).not.toContain("AA指数");
    // A failed AA board keeps its previous snapshot untouched.
    expect(harness.store.loadRanking("aa-intelligence")?.savedAt).toBe("2026-08-15T22:00:00.000Z");
    expect(harness.store.loadRanking("lmarena-overall")?.entries[0]?.name).toBe("model-a");
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });

  it("posts a warning-only embed and marks the day when every configured board fails", async () => {
    const harness = createHarness([], []);
    harness.setResponse(
      "lmarena-overall",
      () => Promise.resolve(new Response("down", { status: 404 }))
    );
    harness.setResponse("lmarena-coding", () => Promise.reject(new Error("network unreachable")));

    const result = await runWith(harness);

    expect(result.boards).toEqual({
      "lmarena-overall": "failed",
      "lmarena-coding": "failed"
    });
    expect(harness.sent).toHaveLength(1);
    const allFailed = harness.sent[0]!;
    expect(allFailed.fields.map((field) => field.value)).toEqual([
      "⚠️ ランキングを取得できませんでした。",
      "⚠️ ランキングを取得できませんでした。"
    ]);
    // Nothing succeeded, so no credit is rendered at all.
    expect(allFailed.description).not.toContain("データ:");
    expect(allFailed.footer?.text).not.toContain("データ:");
    expect(harness.store.loadRanking("lmarena-overall")).toBeUndefined();
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });

  it("saves nothing when the Discord post fails, so the next tick retries", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    const failingSend = async (): Promise<void> => {
      throw new Error("discord unavailable");
    };
    await expect(
      runDailyRanking({
        timeZone: "Asia/Tokyo",
        store: harness.store,
        logger,
        send: failingSend,
        fetchFn: harness.fetchFn,
        aaApiKey: "aa_test_key",
        now: fixedNow,
        retryDelayMs: 0
      })
    ).rejects.toThrow(/discord unavailable/);
    expect(harness.store.loadLastPosted()).toBeUndefined();
    expect(harness.store.loadRanking("lmarena-overall")).toBeUndefined();
    expect(harness.store.loadRanking("lmarena-coding")).toBeUndefined();
    expect(harness.store.loadRanking("aa-intelligence")).toBeUndefined();
    expect(harness.store.loadRanking("aa-coding")).toBeUndefined();
  });

  it("appends short prices to matching ranking lines only", async () => {
    const harness = createHarness(["model-a", "model-b"], ["model-x"]);
    harness.setResponse(
      "openrouter",
      () =>
        openRouterResponse([
          {
            id: "vendor/model-a",
            name: "Vendor: model-a",
            hugging_face_id: null,
            created: 10,
            context_length: 200_000,
            pricing: { prompt: "0.0000012", completion: "0.000012" }
          },
          UNRELATED_CATALOG_MODEL
        ])
    );

    await runWith(harness);

    const overallLines = harness.sent[0]!.fields[0]!.value.split("\n");
    expect(overallLines[0]).toContain("1. model-a");
    expect(overallLines[0]).toContain("· $1.2/$12");
    expect(overallLines[1]).not.toContain("$");
  });

  it("matches AA display names to catalog prices", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    harness.setResponse(
      "aa",
      jsonOk(
        aaEnvelope([
          aaModel("id-alpha", "Vendor: aa-alpha", { intelligence: 65.7 }),
          aaModel("id-beta", "aa-beta", { intelligence: 60.1 }),
          aaModel("id-code-1", "aa-code-1", { coding: 71.2 }),
          aaModel("id-code-2", "aa-code-2", { coding: 66.6 })
        ])
      )
    );
    harness.setResponse(
      "openrouter",
      () =>
        openRouterResponse([
          {
            id: "vendor/aa-alpha",
            name: "Vendor: aa-alpha",
            hugging_face_id: null,
            created: 10,
            context_length: 200_000,
            pricing: { prompt: "0.0000012", completion: "0.000012" }
          },
          UNRELATED_CATALOG_MODEL
        ])
    );

    await runWith(harness, { aaApiKey: "aa_test_key" });

    const aaLines = harness.sent[0]!.fields[2]!.value.split("\n");
    expect(aaLines[0]).toContain("1. Vendor: aa-alpha");
    expect(aaLines[0]).toContain("65.7");
    expect(aaLines[0]).toContain("· $1.2/$12");
    // The second AA entry has no catalog match, so it stays price-free.
    expect(aaLines[1]).not.toContain("$");
  });

  it("posts the ranking without prices when OpenRouter fails", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    harness.setResponse(
      "openrouter",
      () => Promise.resolve(new Response("down", { status: 500 }))
    );
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const watchingLogger: Logger = {
      ...logger,
      warn: (message, fields = {}) => {
        warnings.push({ message, fields });
      }
    };

    const result = await runDailyRanking({
      timeZone: "Asia/Tokyo",
      store: harness.store,
      logger: watchingLogger,
      send: harness.send,
      fetchFn: harness.fetchFn,
      now: fixedNow,
      retryDelayMs: 0
    });

    expect(result.boards).toEqual({
      "lmarena-overall": "ok",
      "lmarena-coding": "ok"
    });
    expect(harness.sent).toHaveLength(1);
    for (const field of harness.sent[0]!.fields) {
      expect(field.value).not.toContain("$");
    }
    expect(warnings.some(({ message }) => /OpenRouter pricing unavailable/.test(message))).toBe(
      true
    );
    // Prices are presentation-only: snapshots stay price-free.
    expect(harness.store.loadRanking("lmarena-overall")?.entries[0]).toEqual({
      entityKey: "model-a",
      name: "model-a",
      organization: "Example AI",
      rank: 1,
      score: 1500,
      scoreDisplay: "1500"
    });
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });

  it("treats a rejected pricing fetch the same as an HTTP failure", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    harness.setResponse("openrouter", () => Promise.reject(new Error("network unreachable")));

    const result = await runWith(harness);

    expect(result.posted).toBe(true);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]!.fields[0]!.value).not.toContain("$");
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });

  it("logs skipped boards at info level without counting them as failures", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    const infos: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const watchingLogger: Logger = {
      ...logger,
      info: (message, fields = {}) => {
        infos.push({ message, fields });
      }
    };

    await runDailyRanking({
      timeZone: "Asia/Tokyo",
      store: harness.store,
      logger: watchingLogger,
      send: harness.send,
      fetchFn: harness.fetchFn,
      now: fixedNow,
      retryDelayMs: 0
    });

    const skipped = infos.find(({ message }) => /ranking boards skipped/.test(message));
    expect(skipped?.fields.boards).toEqual(["aa-intelligence", "aa-coding"]);
  });
});
