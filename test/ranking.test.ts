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

interface Harness {
  store: StateStore;
  sent: EmbedPayload[];
  send: (embed: EmbedPayload) => Promise<void>;
  fetchFn: typeof fetch;
  setResponse: (
    board: "overall" | "coding" | "openrouter",
    response: () => Promise<Response>
  ) => void;
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
  const responses = new Map<string, () => Promise<Response>>();
  const respond = (names: string[], key: string) =>
    responses.set(key, () =>
      Promise.resolve(
        new Response(JSON.stringify(boardPage(names)), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
  respond(overallNames, "overall");
  respond(codingNames, "coding");
  responses.set("openrouter", () => openRouterResponse([UNRELATED_CATALOG_MODEL]));
  return {
    store,
    sent,
    send: async (embed) => {
      sent.push(embed);
    },
    fetchFn: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) {
        const responder = responses.get("openrouter");
        if (!responder) throw new Error(`unexpected url: ${url}`);
        return responder();
      }
      const key = url.includes("config=text_style_control") ? "overall" : "coding";
      const responder = responses.get(key);
      if (!responder) throw new Error(`unexpected url: ${url}`);
      return responder();
    }) as typeof fetch,
    setResponse: (board, response) => responses.set(board, response)
  };
}

const fixedNow = () => new Date("2026-08-16T07:00:30.000Z");

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
  it("posts both boards, saves snapshots, and records the day as posted", async () => {
    const harness = createHarness(["model-a", "model-b"], ["model-x", "model-y"]);
    const result = await runDailyRanking({
      timeZone: "Asia/Tokyo",
      store: harness.store,
      logger,
      send: harness.send,
      fetchFn: harness.fetchFn,
      now: fixedNow,
      retryDelayMs: 0
    });

    expect(result).toEqual({
      dateKey: "2026-08-16",
      posted: true,
      boards: { overall: "ok", coding: "ok" }
    });
    expect(harness.sent).toHaveLength(1);
    const embed = harness.sent[0]!;
    expect(embed.fields.map((field) => field.name)).toEqual([
      "🏆 LMArena Overall",
      "💻 LMArena Coding"
    ]);
    expect(embed.fields[0]?.value).toContain("🥇 1. model-a");
    expect(harness.store.loadRanking("overall")?.entries.map((entry) => entry.name)).toEqual([
      "model-a",
      "model-b"
    ]);
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });

  it("shows deltas against the previous snapshot and marks new entries", async () => {
    const harness = createHarness(["model-a", "model-new"], ["model-x"]);
    harness.store.saveRanking(
      "overall",
      previousEntries(["model-old", "model-a"]),
      "2026-08-15T22:00:00.000Z"
    );
    await runDailyRanking({
      timeZone: "Asia/Tokyo",
      store: harness.store,
      logger,
      send: harness.send,
      fetchFn: harness.fetchFn,
      now: fixedNow,
      retryDelayMs: 0
    });
    const value = harness.sent[0]!.fields[0]!.value;
    expect(value).toContain("1. model-a");
    expect(value).toContain("⬆️ +1");
    expect(value).toContain("2. model-new");
    expect(value).toContain("🆕 NEW");
  });

  it("keeps posting when only one board fails, and preserves that board's snapshot", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    harness.store.saveRanking(
      "coding",
      previousEntries(["model-x"]),
      "2026-08-15T22:00:00.000Z"
    );
    harness.setResponse(
      "coding",
      () => Promise.resolve(new Response("server error", { status: 500 }))
    );

    const result = await runDailyRanking({
      timeZone: "Asia/Tokyo",
      store: harness.store,
      logger,
      send: harness.send,
      fetchFn: harness.fetchFn,
      now: fixedNow,
      retryDelayMs: 0
    });

    expect(result.boards).toEqual({ overall: "ok", coding: "failed" });
    const embed = harness.sent[0]!;
    expect(embed.fields[0]?.value).toContain("model-a");
    expect(embed.fields[1]?.value).toBe("⚠️ ランキングを取得できませんでした。");
    // The previous coding snapshot survives untouched for the next comparison.
    expect(harness.store.loadRanking("coding")?.savedAt).toBe("2026-08-15T22:00:00.000Z");
    expect(harness.store.loadRanking("overall")?.entries[0]?.name).toBe("model-a");
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });

  it("posts a warning-only embed and marks the day when both boards fail", async () => {
    const harness = createHarness([], []);
    harness.setResponse(
      "overall",
      () => Promise.resolve(new Response("down", { status: 404 }))
    );
    harness.setResponse(
      "coding",
      () => Promise.reject(new Error("network unreachable"))
    );

    const result = await runDailyRanking({
      timeZone: "Asia/Tokyo",
      store: harness.store,
      logger,
      send: harness.send,
      fetchFn: harness.fetchFn,
      now: fixedNow,
      retryDelayMs: 0
    });

    expect(result.boards).toEqual({ overall: "failed", coding: "failed" });
    expect(harness.sent).toHaveLength(1);
    for (const field of harness.sent[0]!.fields) {
      expect(field.value).toBe("⚠️ ランキングを取得できませんでした。");
    }
    expect(harness.store.loadRanking("overall")).toBeUndefined();
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
        now: fixedNow,
        retryDelayMs: 0
      })
    ).rejects.toThrow(/discord unavailable/);
    expect(harness.store.loadLastPosted()).toBeUndefined();
    expect(harness.store.loadRanking("overall")).toBeUndefined();
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

    await runDailyRanking({
      timeZone: "Asia/Tokyo",
      store: harness.store,
      logger,
      send: harness.send,
      fetchFn: harness.fetchFn,
      now: fixedNow,
      retryDelayMs: 0
    });

    const overallLines = harness.sent[0]!.fields[0]!.value.split("\n");
    expect(overallLines[0]).toContain("1. model-a");
    expect(overallLines[0]).toContain("· $1.2/$12");
    expect(overallLines[1]).not.toContain("$");
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

    expect(result.boards).toEqual({ overall: "ok", coding: "ok" });
    expect(harness.sent).toHaveLength(1);
    for (const field of harness.sent[0]!.fields) {
      expect(field.value).not.toContain("$");
    }
    expect(warnings.some(({ message }) => /OpenRouter pricing unavailable/.test(message))).toBe(
      true
    );
    // Prices are presentation-only: snapshots stay price-free.
    expect(harness.store.loadRanking("overall")?.entries[0]).toEqual({
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

    const result = await runDailyRanking({
      timeZone: "Asia/Tokyo",
      store: harness.store,
      logger,
      send: harness.send,
      fetchFn: harness.fetchFn,
      now: fixedNow,
      retryDelayMs: 0
    });

    expect(result.posted).toBe(true);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]!.fields[0]!.value).not.toContain("$");
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });
});
