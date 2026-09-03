import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AA_BOARDS,
  ARTIFICIAL_ANALYSIS_MODELS_URL,
  collectArtificialAnalysisTop,
  createArtificialAnalysisLoader,
  fetchArtificialAnalysisTop,
  parseArtificialAnalysisPage
} from "../src/artificialanalysis.js";
import type { AaScoreKey, ArtificialAnalysisModel } from "../src/artificialanalysis.js";

const FABLE_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const INTELLIGENCE = "artificial_analysis_intelligence_index" as const satisfies AaScoreKey;

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function page1(): Record<string, unknown> {
  return JSON.parse(fixture("aa-models-free.json")) as Record<string, unknown>;
}

function page2(): unknown {
  return JSON.parse(fixture("aa-models-free-page2.json")) as unknown;
}

interface CapturedFetch {
  url: string;
  headers: Record<string, string>;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function model(
  id: string,
  name: string,
  scores: Partial<Record<AaScoreKey, number>>,
  creator?: string
): ArtificialAnalysisModel {
  return {
    id,
    name,
    ...(creator ? { creatorName: creator } : {}),
    scores
  };
}

function capturingLogger(warnings: Array<{ message: string; fields: Record<string, unknown> }>) {
  return {
    debug: () => undefined,
    info: () => undefined,
    error: () => undefined,
    warn: (message: string, fields: Record<string, unknown> = {}) => {
      warnings.push({ message, fields });
    }
  };
}

describe("AA board registry", () => {
  it("pins the two board identities the state files and embeds rely on", () => {
    expect(AA_BOARDS.intelligence).toMatchObject({
      board: "intelligence",
      leaderboardId: "aa-intelligence",
      displayName: "AA Intelligence",
      emoji: "🧠",
      scoreKey: "artificial_analysis_intelligence_index"
    });
    expect(AA_BOARDS.coding).toMatchObject({
      board: "coding",
      leaderboardId: "aa-coding",
      displayName: "AA Coding",
      emoji: "🛠️",
      scoreKey: "artificial_analysis_coding_index"
    });
  });
});

describe("Artificial Analysis page parsing", () => {
  it("parses the free-tier envelope and maps the known columns only", () => {
    const parsed = parseArtificialAnalysisPage(page1());
    expect(parsed.tier).toBe("free");
    expect(parsed.intelligenceIndexVersion).toBe("4.1");
    expect(parsed.pagination).toEqual({ page: 1, hasMore: true });
    expect(parsed.models).toHaveLength(6);
    const fable = parsed.models.find((entry) => entry.name === "Fable 5.1");
    expect(fable).toMatchObject({
      id: FABLE_ID,
      creatorName: "Example Labs",
      scores: {
        artificial_analysis_intelligence_index: 65.7,
        artificial_analysis_coding_index: 62.4,
        artificial_analysis_agentic_index: 40.1
      }
    });
    // Unknown upstream columns (pricing, performance) must not leak into models.
    expect(Object.keys(fable ?? {})).toEqual(
      expect.arrayContaining(["id", "name", "creatorName", "scores"])
    );
    expect(fable && "pricing" in fable).toBe(false);
  });

  it("normalizes a numeric intelligence_index_version to a display string", () => {
    // The live API ships "4.1" as the number 4.1; the version is display-only.
    const numeric = parseArtificialAnalysisPage({ ...page1(), intelligence_index_version: 4.1 });
    expect(numeric.intelligenceIndexVersion).toBe("4.1");
    const absent = parseArtificialAnalysisPage({ ...page1(), intelligence_index_version: null });
    expect(absent.intelligenceIndexVersion).toBeUndefined();
  });

  it("drops null and absent evaluations instead of coercing them to zero", () => {
    const parsed = parseArtificialAnalysisPage(page1());
    const byName = new Map(parsed.models.map((entry) => [entry.name, entry]));
    expect(byName.get("Nullmind 3")?.scores).toEqual({
      artificial_analysis_coding_index: 55.2
    });
    expect(byName.get("Baremetal 2")?.scores).toEqual({});
    expect(byName.get("Zeta Tie")?.scores).toEqual({
      artificial_analysis_intelligence_index: 48
    });
  });

  it("fails closed on an empty data array", () => {
    expect(() =>
      parseArtificialAnalysisPage({
        tier: "free",
        pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
        data: []
      })
    ).toThrow(/empty data/);
  });

  it("rejects rows without an id or a name", () => {
    expect(() => parseArtificialAnalysisPage({ ...page1(), data: [{ name: "no-id" }] })).toThrow();
    expect(() =>
      parseArtificialAnalysisPage({ ...page1(), data: [{ id: "no-name" }] })
    ).toThrow();
  });

  it("rejects pages without the pagination contract", () => {
    const data = page1().data as unknown[];
    expect(() => parseArtificialAnalysisPage({ data })).toThrow();
    expect(() =>
      parseArtificialAnalysisPage({ ...page1(), pagination: { page: 1, has_more: "no" } })
    ).toThrow();
  });
});

describe("collectArtificialAnalysisTop", () => {
  const models = parseArtificialAnalysisPage(page1()).models;

  it("filters null scores per board, sorts descending, and numbers ranks from 1", () => {
    const intelligence = collectArtificialAnalysisTop(models, "intelligence", 10);
    expect(intelligence.map((entry) => entry.name)).toEqual([
      "Fable 5.1",
      "Alpha Tie",
      "Zeta Tie",
      "Early Budget 1"
    ]);
    expect(intelligence.map((entry) => entry.rank)).toEqual([1, 2, 3, 4]);
    const coding = collectArtificialAnalysisTop(models, "coding", 10);
    // Nullmind has no intelligence index, Zeta Tie no coding index: each
    // missing score removes the model from exactly its own board.
    expect(coding.map((entry) => entry.name)).toEqual([
      "Fable 5.1",
      "Nullmind 3",
      "Alpha Tie",
      "Early Budget 1"
    ]);
  });

  it("breaks score ties by name ascending, not by input order", () => {
    const intelligence = collectArtificialAnalysisTop(models, "intelligence", 10);
    expect(intelligence[1]).toMatchObject({ name: "Alpha Tie", score: 48 });
    expect(intelligence[2]).toMatchObject({ name: "Zeta Tie", score: 48 });
  });

  it("formats scores with exactly one decimal place", () => {
    const intelligence = collectArtificialAnalysisTop(models, "intelligence", 10);
    expect(intelligence.map((entry) => entry.scoreDisplay)).toEqual([
      "65.7",
      "48.0",
      "48.0",
      "21.3"
    ]);
  });

  it("uses the stable AA UUID as the entity key and keeps the creator", () => {
    const intelligence = collectArtificialAnalysisTop(models, "intelligence", 10);
    const fable = intelligence.find((entry) => entry.name === "Fable 5.1");
    expect(fable).toMatchObject({
      entityKey: FABLE_ID,
      organization: "Example Labs",
      score: 65.7
    });
  });

  it("throws on scores outside the 0-100 index scale but keeps 0 and 100", () => {
    const over = [model("id-over", "Over Scale", { [INTELLIGENCE]: 100.5 })];
    expect(() => collectArtificialAnalysisTop(over, "intelligence", 10)).toThrow(/0-100/);
    const under = [model("id-under", "Under Scale", { [INTELLIGENCE]: -0.5 })];
    expect(() => collectArtificialAnalysisTop(under, "intelligence", 10)).toThrow(/0-100/);
    const bounds = [
      model("id-zero", "Zero Scale", { [INTELLIGENCE]: 0 }, "Bounds AI"),
      model("id-max", "Max Scale", { [INTELLIGENCE]: 100 }, "Bounds AI")
    ];
    const entries = collectArtificialAnalysisTop(bounds, "intelligence", 10);
    expect(entries.map((entry) => entry.scoreDisplay)).toEqual(["100.0", "0.0"]);
  });

  it("keeps the higher score when the same id appears twice", () => {
    const duplicated = [
      model("dup-id", "Duplicate", { [INTELLIGENCE]: 10 }),
      model("dup-id", "Duplicate", { [INTELLIGENCE]: 20 })
    ];
    const entries = collectArtificialAnalysisTop(duplicated, "intelligence", 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ score: 20, rank: 1 });
  });

  it("breaks a same-id same-score duplicate toward the smaller name", () => {
    const duplicated = [
      model("tie-id", "Beta Variant", { [INTELLIGENCE]: 20 }),
      model("tie-id", "Alpha Variant", { [INTELLIGENCE]: 20 })
    ];
    const entries = collectArtificialAnalysisTop(duplicated, "intelligence", 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "Alpha Variant", score: 20, rank: 1 });
  });

  it("respects topN", () => {
    const entries = collectArtificialAnalysisTop(models, "intelligence", 2);
    expect(entries.map((entry) => entry.name)).toEqual(["Fable 5.1", "Alpha Tie"]);
    expect(entries.map((entry) => entry.rank)).toEqual([1, 2]);
  });

  it("validates topN", () => {
    expect(() => collectArtificialAnalysisTop(models, "intelligence", 0)).toThrow(/topN/);
    expect(() => collectArtificialAnalysisTop(models, "intelligence", 201)).toThrow(/topN/);
  });
});

describe("fetchArtificialAnalysisTop", () => {
  it("merges two pages via the response cursor and sends x-api-key on every request", async () => {
    const captured: CapturedFetch[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>
      });
      return jsonResponse(String(input).includes("page=2") ? page2() : page1());
    }) as typeof fetch;

    const entries = await fetchArtificialAnalysisTop("intelligence", {
      apiKey: "aa_test_key",
      fetchFn
    });
    expect(captured).toHaveLength(2);
    // Page 1 must be requested without a page parameter; page 2 follows the
    // cursor reported by the first response, not a local counter.
    expect(captured[0]?.url).toBe(ARTIFICIAL_ANALYSIS_MODELS_URL);
    expect(new URL(captured[1]!.url).searchParams.get("page")).toBe("2");
    for (const request of captured) {
      expect(request.headers["x-api-key"]).toBe("aa_test_key");
      expect(request.headers.accept).toBe("application/json");
    }
    expect(entries.map((entry) => entry.name)).toEqual([
      "Apex Reasoner 9",
      "Fable 5.1",
      "Alpha Tie",
      "Zeta Tie",
      "Early Budget 1"
    ]);
    expect(entries.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("dedupes an id repeated across pages per board score", async () => {
    const fetchFn = (async (input: string | URL | Request) =>
      jsonResponse(String(input).includes("page=2") ? page2() : page1())) as typeof fetch;

    const intelligence = await fetchArtificialAnalysisTop("intelligence", {
      apiKey: "aa_test_key",
      fetchFn
    });
    // Page 1 scores 65.7, page 2 repeats the id with 60.0: the higher wins.
    expect(intelligence.find((entry) => entry.entityKey === FABLE_ID)).toMatchObject({
      score: 65.7,
      scoreDisplay: "65.7"
    });

    const coding = await fetchArtificialAnalysisTop("coding", { apiKey: "aa_test_key", fetchFn });
    // For the coding board the page-2 row (64.0) is the higher one.
    expect(coding.map((entry) => entry.name)).toEqual([
      "Apex Reasoner 9",
      "Fable 5.1",
      "Nullmind 3",
      "Alpha Tie",
      "Early Budget 1"
    ]);
    expect(coding.find((entry) => entry.name === "Fable 5.1")).toMatchObject({ score: 64 });
  });

  it("fails closed when has_more outlives the page cap", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse(
        scoredPage(`cap-model-${calls}`, calls, 50)
      );
    }) as typeof fetch;

    await expect(
      fetchArtificialAnalysisTop("intelligence", { apiKey: "aa_test_key", fetchFn, retryDelayMs: 0 })
    ).rejects.toThrow(/has_more after 8 pages/);
    expect(calls).toBe(8);
  });

  it("fails closed when the reported page number stops advancing", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      // The cursor asks for page 2 from the second request on, but upstream
      // keeps answering with page 1 — a walk that would only collect copies.
      return jsonResponse(scoredPage("stall-model", 1, 50));
    }) as typeof fetch;

    await expect(
      fetchArtificialAnalysisTop("intelligence", { apiKey: "aa_test_key", fetchFn, retryDelayMs: 0 })
    ).rejects.toThrow(/did not advance/);
    expect(calls).toBe(2);
  });

  it("fails closed on an empty data array mid-walk", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        tier: "free",
        pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
        data: []
      })) as typeof fetch;

    await expect(
      fetchArtificialAnalysisTop("intelligence", { apiKey: "aa_test_key", fetchFn })
    ).rejects.toThrow(/empty data/);
  });

  it("reports a rejected key exactly once without retrying", async () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response('{"error":"invalid api key"}', { status: 401 });
    }) as typeof fetch;

    await expect(
      fetchArtificialAnalysisTop("intelligence", {
        apiKey: "aa_bad_key",
        fetchFn,
        logger: capturingLogger(warnings),
        retryDelayMs: 0
      })
    ).rejects.toThrow(/Artificial Analysis rejected the API key \(HTTP 401\); check AA_API_KEY/);
    expect(calls).toBe(1);

    let forbiddenCalls = 0;
    const forbiddenFetch = (async () => {
      forbiddenCalls += 1;
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;
    await expect(
      fetchArtificialAnalysisTop("coding", { apiKey: "aa_bad_key", fetchFn: forbiddenFetch })
    ).rejects.toThrow(/AA_API_KEY.*403|403.*AA_API_KEY/s);
    expect(forbiddenCalls).toBe(1);
  });

  it("retries 429 rate limits like transient 5xx failures", async () => {
    let calls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      calls += 1;
      if (calls === 1) return new Response("slow down", { status: 429 });
      return jsonResponse(String(input).includes("page=2") ? page2() : page1());
    }) as typeof fetch;

    const entries = await fetchArtificialAnalysisTop("intelligence", {
      apiKey: "aa_test_key",
      fetchFn,
      retryDelayMs: 0
    });
    expect(entries).toHaveLength(5);
    expect(calls).toBe(3);
  });

  it("gives up after three 5xx attempts and logs each one", async () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    }) as typeof fetch;

    await expect(
      fetchArtificialAnalysisTop("intelligence", {
        apiKey: "aa_test_key",
        fetchFn,
        logger: capturingLogger(warnings),
        retryDelayMs: 0
      })
    ).rejects.toThrow(/500/);
    expect(calls).toBe(3);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatchObject({
      message: "Artificial Analysis fetch attempt failed",
      fields: expect.objectContaining({
        leaderboard: "aa-intelligence",
        url: ARTIFICIAL_ANALYSIS_MODELS_URL,
        attempt: 1,
        status: 500
      })
    });
  });

  it("makes zero requests and throws without an API key", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse(page1());
    }) as typeof fetch;

    await expect(fetchArtificialAnalysisTop("intelligence", { fetchFn })).rejects.toThrow(
      /AA_API_KEY/
    );
    expect(calls).toBe(0);
  });

  it("validates topN before requesting anything", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse(page1());
    }) as typeof fetch;

    await expect(
      fetchArtificialAnalysisTop("intelligence", { topN: 0, apiKey: "k", fetchFn })
    ).rejects.toThrow(/topN/);
    await expect(
      fetchArtificialAnalysisTop("intelligence", { topN: 201, apiKey: "k", fetchFn })
    ).rejects.toThrow(/topN/);
    expect(calls).toBe(0);
  });
});

describe("createArtificialAnalysisLoader", () => {
  it("serves concurrent and sequential loads from one walk", async () => {
    let calls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      calls += 1;
      return jsonResponse(String(input).includes("page=2") ? page2() : page1());
    }) as typeof fetch;
    const loader = createArtificialAnalysisLoader({ apiKey: "aa_test_key", fetchFn });

    const [first, second] = await Promise.all([loader.load(), loader.load()]);
    const third = await loader.load();
    expect(calls).toBe(2);
    expect(third).toBe(first);
    expect(second).toBe(first);
    // One walk: page 1's six models merged with page 2's three.
    expect(first.models).toHaveLength(9);
    expect(first.intelligenceIndexVersion).toBe("4.1");
  });

  it("memoizes the rejection so a failed walk costs one attempt set", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    const loader = createArtificialAnalysisLoader({ apiKey: "aa_test_key", fetchFn, retryDelayMs: 0 });

    await expect(loader.load()).rejects.toThrow(/500/);
    await expect(loader.load()).rejects.toThrow(/500/);
    expect(calls).toBe(3);
  });

  it("rejects without an API key before any request", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse(page1());
    }) as typeof fetch;
    const loader = createArtificialAnalysisLoader({ fetchFn });

    await expect(loader.load()).rejects.toThrow(/AA_API_KEY/);
    await expect(loader.load()).rejects.toThrow(/AA_API_KEY/);
    expect(calls).toBe(0);
  });
});

/** One-row page whose page number equals `page`, used for cap/stall tests. */
function scoredPage(name: string, page: number, score: number): unknown {
  return {
    tier: "free",
    pagination: { page, page_size: 200, total_pages: 99, has_more: true },
    data: [
      {
        id: `id-${name}`,
        name,
        evaluations: { artificial_analysis_intelligence_index: score }
      }
    ]
  };
}
