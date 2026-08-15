import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fetchLmArenaTop,
  parseLmArenaFilterPage,
  parseLmArenaRowsPage
} from "../src/lmarena.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
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

function page(rows: Array<Record<string, unknown>>, total = rows.length): unknown {
  return {
    rows: rows.map((row, index) => ({ row_idx: index, row, truncated_cells: [] })),
    num_rows_total: total,
    num_rows_per_page: 100,
    partial: false
  };
}

function row(name: string, rank: number, rating: number): Record<string, unknown> {
  return {
    model_name: name,
    organization: "Example AI",
    rating,
    rank,
    category: "overall",
    leaderboard_publish_date: "2026-08-12"
  };
}

describe("LMArena page parsing", () => {
  it("validates a filter page and its requested category", () => {
    const payload = JSON.parse(fixture("lmarena-page.json")) as unknown;
    const parsed = parseLmArenaFilterPage(payload, "overall");
    expect(parsed.total).toBe(2);
    expect(parsed.rows.map((arenaRow) => arenaRow.model_name)).toEqual([
      "model-alpha",
      "model-beta"
    ]);
    expect(() => parseLmArenaFilterPage(payload, "coding")).toThrow(/category mismatch/);
  });

  it("parses a /rows page for the webdev config without a category column", () => {
    const payload = JSON.parse(fixture("lmarena-rows-page.json")) as unknown;
    const parsed = parseLmArenaRowsPage(payload);
    expect(parsed.total).toBe(2);
    expect(parsed.rows.map((arenaRow) => arenaRow.model_name)).toEqual([
      "model-gamma",
      "model-delta"
    ]);
  });

  it("fails closed on partial responses", () => {
    expect(() =>
      parseLmArenaFilterPage(
        { ...(page([row("a", 1, 1400)]) as Record<string, unknown>), partial: true },
        "overall"
      )
    ).toThrow(/partial/);
  });
});

describe("fetchLmArenaTop", () => {
  it("fetches one first page per board, sorts by rank, and rounds scores", async () => {
    const captured: CapturedFetch[] = [];
    const shuffled = [
      row("model-b", 2, 1419.6),
      row("model-a", 1, 1430.4),
      row("model-c", 3, 1401.2)
    ];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>
      });
      return jsonResponse(page(shuffled));
    }) as typeof fetch;

    const overall = await fetchLmArenaTop("overall", { fetchFn });
    expect(overall.map((entry) => entry.name)).toEqual(["model-a", "model-b", "model-c"]);
    expect(overall[0]).toMatchObject({ rank: 1, score: 1430, scoreDisplay: "1430" });
    expect(overall.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(captured[0]?.url).toContain("datasets-server.huggingface.co/filter");
    expect(captured[0]?.url).toContain("length=100");

    const coding = await fetchLmArenaTop("coding", { fetchFn });
    expect(coding).toHaveLength(3);
    expect(captured[1]?.url).toContain("datasets-server.huggingface.co/rows");
    expect(captured[1]?.url).toContain("config=webdev");
  });

  it("slices to the requested top N and sends the bearer token when present", async () => {
    const captured: CapturedFetch[] = [];
    const many = Array.from({ length: 12 }, (_unused, index) =>
      row(`model-${index + 1}`, index + 1, 1500 - index)
    );
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>
      });
      return jsonResponse(page(many));
    }) as typeof fetch;

    const top = await fetchLmArenaTop("overall", { topN: 10, token: "hf-token", fetchFn });
    expect(top).toHaveLength(10);
    expect(top.at(-1)?.name).toBe("model-10");
    expect(captured[0]?.headers.authorization).toBe("Bearer hf-token");
    await expect(fetchLmArenaTop("overall", { topN: 0, fetchFn })).rejects.toThrow(/topN/);
  });

  it("keeps the best-ranked row when the same model name appears twice", async () => {
    // Observed live: the webdev config lists one model as two separate rows
    // (different harness configurations) with different ranks and ratings.
    const duplicated = [
      row("model-a", 1, 1500),
      row("shared-model", 59, 1408.6),
      row("model-b", 2, 1490),
      row("shared-model", 76, 1369.3)
    ];
    const fetchFn = (async () => jsonResponse(page(duplicated))) as typeof fetch;

    const entries = await fetchLmArenaTop("coding", { fetchFn });
    expect(entries.map((entry) => entry.name)).toEqual(["model-a", "model-b", "shared-model"]);
    expect(entries.find((entry) => entry.name === "shared-model")).toMatchObject({
      rank: 59,
      score: 1409
    });
  });

  it("propagates HTTP failures so the board can be reported as unavailable", async () => {
    const fetchFn = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(fetchLmArenaTop("overall", { fetchFn })).rejects.toThrow(/500/);
  });
});
