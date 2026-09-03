import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderSource, RawAnnouncement } from "../src/announcements/index.js";
import { loadConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import { Scheduler } from "../src/scheduler.js";
import { StateStore } from "../src/state.js";
import type { EmbedPayload } from "../src/types.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function rankingResponse(names: string[]): Response {
  return new Response(
    JSON.stringify({
      rows: names.map((name, index) => ({
        row_idx: index,
        row: {
          model_name: name,
          rating: 1500 - index,
          rank: index + 1,
          category: "overall",
          leaderboard_publish_date: "2026-08-12"
        },
        truncated_cells: []
      })),
      num_rows_total: names.length,
      num_rows_per_page: 100,
      partial: false
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function aaModelsResponse(): Response {
  return new Response(
    JSON.stringify({
      tier: "free",
      intelligence_index_version: "4.1",
      pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
      data: [
        {
          id: "id-alpha",
          name: "aa-alpha",
          model_creator: { id: "creator-1", name: "Example AI" },
          evaluations: {
            artificial_analysis_intelligence_index: 65.7,
            artificial_analysis_coding_index: null,
            artificial_analysis_agentic_index: null
          }
        },
        {
          id: "id-code-1",
          name: "aa-code-1",
          model_creator: { id: "creator-1", name: "Example AI" },
          evaluations: {
            artificial_analysis_intelligence_index: null,
            artificial_analysis_coding_index: 71.2,
            artificial_analysis_agentic_index: null
          }
        }
      ]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

interface FetchCounts {
  aaRequests: number;
}

/** Routes each source URL to a small healthy envelope, counting AA calls. */
function dispatchingFetch(counts: FetchCounts): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("artificialanalysis.ai")) {
      counts.aaRequests += 1;
      return aaModelsResponse();
    }
    return rankingResponse(["model-a", "model-b"]);
  }) as typeof fetch;
}

const quietSource: ProviderSource = {
  id: "openai",
  providerName: "OpenAI",
  displayName: "stub",
  fetchUrl: "https://example.com/openai",
  accept: "text/html",
  parse: (): RawAnnouncement[] => []
};

interface Harness {
  scheduler: Scheduler;
  store: StateStore;
  sent: EmbedPayload[];
  now: () => Date;
  counts: FetchCounts;
  setNow: (date: Date) => void;
}

function createHarness(options: { digestHour?: number; digestMinute?: number; aaApiKey?: string } = {}): Harness {
  const store = new StateStore(mkdtempSync(join(tmpdir(), "scheduler-")));
  const sent: EmbedPayload[] = [];
  let current = new Date("2026-08-16T00:30:00.000Z"); // 09:30 JST, after a 07:00 digest time
  const now = () => current;
  const counts: FetchCounts = { aaRequests: 0 };
  const config = {
    ...loadConfig({}),
    timeZone: "Asia/Tokyo",
    digestHour: options.digestHour ?? 7,
    digestMinute: options.digestMinute ?? 0,
    ...(options.aaApiKey ? { aaApiKey: options.aaApiKey } : {})
  };
  return {
    scheduler: new Scheduler({
      config,
      store,
      logger,
      send: async (embed) => {
        sent.push(embed);
      },
      fetchFn: dispatchingFetch(counts),
      sources: [quietSource],
      now
    }),
    store,
    sent,
    now,
    counts,
    setNow: (date: Date) => {
      current = date;
    }
  };
}

describe("Scheduler", () => {
  it("catches up on the daily ranking when started after the digest time", async () => {
    const harness = createHarness();
    await harness.scheduler.tick();
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]!.title).toBe("📊 AI Benchmark Daily");
    expect(harness.store.loadLastPosted()?.dateKey).toBe("2026-08-16");
  });

  it("forwards aaApiKey and posts all four boards when configured", async () => {
    const harness = createHarness({ aaApiKey: "aa_test_key" });
    await harness.scheduler.tick();
    expect(harness.sent[0]!.fields.map((field) => field.name)).toEqual([
      "🏆 LMArena Overall",
      "💻 LMArena Coding",
      "🧠 AA Intelligence",
      "🛠️ AA Coding"
    ]);
    // Both AA boards read one memoized loader.
    expect(harness.counts.aaRequests).toBe(1);
    expect(harness.store.loadRanking("aa-intelligence")).toBeDefined();
  });

  it("never contacts Artificial Analysis without a configured key", async () => {
    const harness = createHarness();
    await harness.scheduler.tick();
    expect(harness.sent[0]!.fields).toHaveLength(2);
    expect(harness.sent[0]!.fields.map((field) => field.name)).not.toContain("🧠 AA Intelligence");
    expect(harness.counts.aaRequests).toBe(0);
    expect(harness.store.loadRanking("aa-intelligence")).toBeUndefined();
  });

  it("does not post twice on the same day", async () => {
    const harness = createHarness();
    await harness.scheduler.tick();
    await harness.scheduler.tick();
    expect(harness.sent).toHaveLength(1);
  });

  it("skips the ranking before the digest time and posts after it", async () => {
    const harness = createHarness({ digestHour: 23, digestMinute: 45 });
    harness.setNow(new Date("2026-08-16T14:43:00.000Z")); // 23:43 JST
    await harness.scheduler.tick();
    expect(harness.sent).toHaveLength(0);

    harness.setNow(new Date("2026-08-16T14:45:00.000Z")); // 23:45 JST
    await harness.scheduler.tick();
    expect(harness.sent).toHaveLength(1);
  });

  it("polls alerts on the first tick and then respects the poll interval", async () => {
    const store = new StateStore(mkdtempSync(join(tmpdir(), "scheduler-")));
    const sent: EmbedPayload[] = [];
    let current = new Date("2026-08-16T00:30:00.000Z");
    let polls = 0;
    const counts: FetchCounts = { aaRequests: 0 };
    const scheduler = new Scheduler({
      config: { ...loadConfig({}), timeZone: "Asia/Tokyo", alertPollMinutes: 60 },
      store,
      logger,
      send: async (embed) => {
        sent.push(embed);
      },
      fetchFn: dispatchingFetch(counts),
      sources: [
        {
          ...quietSource,
          parse: () => {
            polls += 1;
            return [];
          }
        }
      ],
      now: () => current
    });

    await scheduler.tick();
    expect(polls).toBe(1);
    // The baseline poll was silent; a confirmed model now appears.
    await scheduler.tick();
    expect(polls).toBe(1);

    current = new Date("2026-08-16T02:30:00.000Z"); // +2h: interval elapsed
    await scheduler.tick();
    expect(polls).toBe(2);
    expect(store.hasSeenModels()).toBe(true);
  });

  it("stops cleanly", async () => {
    const harness = createHarness();
    harness.scheduler.start();
    await harness.scheduler.stop();
    expect(harness.sent).toHaveLength(0);
  });
});
