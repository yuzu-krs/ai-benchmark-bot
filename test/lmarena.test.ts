import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchLmArenaTop, parseLmArenaRowsPage } from "../src/lmarena.js";

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

function row(
  name: string,
  rank: number,
  rating: number,
  category?: string
): Record<string, unknown> {
  return {
    model_name: name,
    organization: "Example AI",
    rating,
    rank,
    ...(category ? { category } : {}),
    leaderboard_publish_date: "2026-08-12"
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

describe("LMArena rows page parsing", () => {
  it("parses a category page and keeps unmapped columns", () => {
    const payload = JSON.parse(fixture("lmarena-page.json")) as unknown;
    const parsed = parseLmArenaRowsPage(payload);
    expect(parsed.total).toBe(2);
    expect(parsed.rows.map((arenaRow) => arenaRow.model_name)).toEqual([
      "model-alpha",
      "model-beta"
    ]);
    expect(parsed.rows.every((arenaRow) => arenaRow.category === "overall")).toBe(true);
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
      parseLmArenaRowsPage({ ...(page([row("a", 1, 1400)]) as Record<string, unknown>), partial: true })
    ).toThrow(/partial/);
  });

  it("rejects rows missing required columns", () => {
    expect(() =>
      parseLmArenaRowsPage(
        page([{ model_name: "model-x", rating: 1400, rank: 1 } as Record<string, unknown>])
      )
    ).toThrow(/leaderboard_publish_date/);
  });

  it("parses /first-rows payloads that omit the pagination counters", () => {
    const { rows } = page([
      row("model-a", 1, 1500, "overall"),
      row("model-b", 2, 1490, "overall")
    ]) as { rows: unknown[] };
    const parsed = parseLmArenaRowsPage({ dataset: "lmarena-ai/leaderboard-dataset", rows });
    expect(parsed.rows.map((arenaRow) => arenaRow.model_name)).toEqual(["model-a", "model-b"]);
    expect(parsed.total).toBe(2);
  });
});

describe("fetchLmArenaTop", () => {
  it("reads /rows for both boards, sorts by rank, and rounds scores", async () => {
    const captured: CapturedFetch[] = [];
    const shuffled = [
      row("model-b", 2, 1419.6, "overall"),
      row("model-a", 1, 1430.4, "overall"),
      row("model-c", 3, 1401.2, "overall")
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
    const overallUrl = new URL(captured[0]!.url);
    expect(overallUrl.href).toContain("datasets-server.huggingface.co/rows");
    expect(overallUrl.searchParams.get("dataset")).toBe("lmarena-ai/leaderboard-dataset");
    expect(overallUrl.searchParams.get("config")).toBe("text_style_control");
    expect(overallUrl.searchParams.get("split")).toBe("latest");
    expect(overallUrl.searchParams.get("offset")).toBe("0");
    expect(overallUrl.searchParams.get("length")).toBe("100");

    const coding = await fetchLmArenaTop("coding", { fetchFn });
    expect(coding).toHaveLength(3);
    const codingUrl = new URL(captured[1]!.url);
    expect(codingUrl.href).toContain("datasets-server.huggingface.co/rows");
    expect(codingUrl.searchParams.get("dataset")).toBe("lmarena-ai/leaderboard-dataset");
    expect(codingUrl.searchParams.get("config")).toBe("webdev");
    expect(codingUrl.searchParams.get("split")).toBe("latest");
  });

  it("picks the highest-priority category from one page and stops paging", async () => {
    const urls: string[] = [];
    // The live config serves 'overall' as the first, largest group.
    const many = Array.from({ length: 12 }, (_unused, index) =>
      row(`model-${index + 1}`, index + 1, 1500 - index, "overall")
    );
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse(page(many, 389));
    }) as typeof fetch;

    const top = await fetchLmArenaTop("overall", { topN: 10, fetchFn });
    expect(top).toHaveLength(10);
    expect(top.at(-1)?.name).toBe("model-10");
    expect(urls).toHaveLength(1);
  });

  it("falls back to the next category key within the same fetched page", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse(
        page(Array.from({ length: 10 }, (_unused, index) => row(`model-${index + 1}`, index + 1, 1500 - index, "text")), 389)
      );
    }) as typeof fetch;

    const entries = await fetchLmArenaTop("overall", { fetchFn });
    expect(entries).toHaveLength(10);
    expect(entries[0]?.name).toBe("model-1");
    expect(urls).toHaveLength(1);
  });

  it("serves the highest-priority key when both category keys are present", async () => {
    const both = [
      ...Array.from({ length: 12 }, (_unused, index) =>
        row(`overall-${index + 1}`, index + 1, 1500 - index, "overall")
      ),
      ...Array.from({ length: 12 }, (_unused, index) => row(`text-${index + 1}`, index + 1, 1400 - index, "text"))
    ];
    const fetchFn = (async () => jsonResponse(page(both, 389))) as typeof fetch;

    const entries = await fetchLmArenaTop("overall", { topN: 10, fetchFn });
    expect(entries).toHaveLength(10);
    expect(entries.every((entry) => entry.name.startsWith("overall-"))).toBe(true);
  });

  it("serves only the selected category when pages mix categories", async () => {
    // A short overall group forces the partial path with foreign rows in hand.
    const mixed = [
      row("overall-a", 1, 1500, "overall"),
      row("overall-b", 2, 1490, "overall"),
      row("math-a", 3, 1480, "math"),
      row("math-b", 4, 1470, "math"),
      row("coding-a", 5, 1460, "coding")
    ];
    const fetchFn = (async () => jsonResponse(page(mixed))) as typeof fetch;

    const entries = await fetchLmArenaTop("overall", { fetchFn });
    expect(entries.map((entry) => entry.name)).toEqual(["overall-a", "overall-b"]);
  });

  it("excludes foreign categories on the ready path too", async () => {
    const mathPage = Array.from({ length: 10 }, (_unused, index) =>
      row(`math-${index + 1}`, index + 1, 1480 - index, "math")
    );
    const overallPage = Array.from({ length: 10 }, (_unused, index) =>
      row(`overall-${index + 1}`, index + 1, 1500 - index, "overall")
    );
    const fetchFn = (async (input: string | URL | Request) =>
      jsonResponse(
        page(String(input).includes("offset=0") ? mathPage : overallPage, 250)
      )) as typeof fetch;

    const entries = await fetchLmArenaTop("overall", { fetchFn });
    expect(entries).toHaveLength(10);
    expect(entries.every((entry) => entry.name.startsWith("overall-"))).toBe(true);
  });

  it("pages until a category collected enough rows", async () => {
    const urls: string[] = [];
    const firstPage = Array.from({ length: 4 }, (_unused, index) =>
      row(`model-${index + 1}`, index + 1, 1500 - index, "overall")
    );
    const secondPage = Array.from({ length: 20 }, (_unused, index) =>
      row(`model-${index + 5}`, index + 5, 1496 - index, "overall")
    );
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      // Page 2 resumes after the 4 rows actually returned, not after the
      // requested page size.
      return jsonResponse(page(url.includes("offset=0") ? firstPage : secondPage, 250));
    }) as typeof fetch;

    const entries = await fetchLmArenaTop("overall", { fetchFn });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("offset=4");
    expect(entries).toHaveLength(10);
    expect(entries.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("serves a short board when the category has fewer models than topN", async () => {
    const fetchFn = (async () =>
      jsonResponse(page([row("model-a", 1, 1500, "overall"), row("model-b", 2, 1490, "overall")]))) as typeof fetch;

    const entries = await fetchLmArenaTop("overall", { fetchFn });
    expect(entries.map((entry) => entry.name)).toEqual(["model-a", "model-b"]);
  });

  it("sends the bearer token when present and validates topN", async () => {
    const captured: CapturedFetch[] = [];
    const many = Array.from({ length: 12 }, (_unused, index) =>
      row(`model-${index + 1}`, index + 1, 1500 - index, "overall")
    );
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>
      });
      return jsonResponse(page(many, 389));
    }) as typeof fetch;

    const top = await fetchLmArenaTop("overall", { topN: 10, token: "hf-token", fetchFn });
    expect(top).toHaveLength(10);
    expect(captured[0]?.headers.authorization).toBe("Bearer hf-token");
    await expect(fetchLmArenaTop("overall", { topN: 0, fetchFn })).rejects.toThrow(/topN/);
  });

  it("keeps the best-ranked row when the same model name appears twice", async () => {
    // Observed live: the webdev config lists one model as two separate rows
    // (different harness configurations) with different ranks and ratings.
    const duplicated = [
      row("model-a", 1, 1500),
      row("model-b", 2, 1490),
      row("shared-model", 3, 1408.6),
      row("shared-model", 4, 1369.3)
    ];
    const fetchFn = (async () => jsonResponse(page(duplicated))) as typeof fetch;

    const entries = await fetchLmArenaTop("coding", { fetchFn });
    expect(entries.map((entry) => entry.name)).toEqual(["model-a", "model-b", "shared-model"]);
    expect(entries.find((entry) => entry.name === "shared-model")).toMatchObject({
      rank: 3,
      score: 1409
    });
  });

  it("recovers when a transient 500 clears on retry within the same page", async () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls < 3) {
        return new Response('{"error":"the dataset index is loading"}', { status: 500 });
      }
      return jsonResponse(page([row("model-a", 1, 1500, "overall")]));
    }) as typeof fetch;

    const entries = await fetchLmArenaTop("overall", {
      fetchFn,
      logger: capturingLogger(warnings),
      retryDelayMs: 0
    });
    expect(entries.map((entry) => entry.name)).toEqual(["model-a"]);
    expect(calls).toBe(3);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({
      message: "LMArena leaderboard fetch attempt failed",
      fields: expect.objectContaining({
        leaderboard: "lmarena-overall",
        url: expect.stringContaining("datasets-server.huggingface.co/rows"),
        attempt: 1,
        status: 500,
        response: expect.stringContaining("index is loading")
      })
    });
  });

  it("retries 429 rate limits like transient 5xx failures", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return new Response("slow down", { status: 429 });
      return jsonResponse(page([row("model-a", 1, 1500, "overall")]));
    }) as typeof fetch;

    const entries = await fetchLmArenaTop("overall", { fetchFn, retryDelayMs: 0 });
    expect(entries.map((entry) => entry.name)).toEqual(["model-a"]);
    expect(calls).toBe(2);
  });

  it("falls back to /first-rows when /rows stays locked (config board)", async () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/rows?")) {
        return new Response('{"error":"the dataset is currently locked, please try again later."}', {
          status: 501
        });
      }
      return jsonResponse(page([row("model-a", 1, 1690), row("model-b", 2, 1680)]));
    }) as typeof fetch;

    const entries = await fetchLmArenaTop("coding", {
      fetchFn,
      logger: capturingLogger(warnings),
      retryDelayMs: 0
    });
    expect(entries.map((entry) => entry.name)).toEqual(["model-a", "model-b"]);
    // 3 /rows attempts, then one /first-rows request that succeeds.
    expect(urls).toHaveLength(4);
    expect(urls.filter((url) => url.includes("/first-rows"))).toHaveLength(1);
    const fallbackUrl = new URL(urls[3]!);
    expect(fallbackUrl.searchParams.get("config")).toBe("webdev");
    expect(fallbackUrl.searchParams.get("split")).toBe("latest");
    expect(warnings.at(-1)).toMatchObject({
      message: "LMArena /rows unavailable; falling back to /first-rows",
      fields: expect.objectContaining({
        leaderboard: "lmarena-coding",
        config: "webdev",
        status: 501,
        response: expect.stringContaining("currently locked")
      })
    });
  });

  it("falls back to /first-rows for category boards too", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/rows?")) return new Response("locked", { status: 501 });
      return jsonResponse(
        page(
          Array.from({ length: 12 }, (_unused, index) =>
            row(`model-${index + 1}`, index + 1, 1500 - index, "overall")
          ),
          389
        )
      );
    }) as typeof fetch;

    const entries = await fetchLmArenaTop("overall", { fetchFn, retryDelayMs: 0 });
    expect(entries).toHaveLength(10);
    expect(entries[0]?.name).toBe("model-1");
    expect(urls).toHaveLength(4);
  });

  it("labels partial-fallback failures with the /first-rows source", async () => {
    // A short overall group with a broken rank run forces the partial path
    // and a rank-run violation — the error must name the degraded source.
    const fetchFn = (async (input: string | URL | Request) => {
      if (String(input).includes("/rows?")) return new Response("locked", { status: 501 });
      return jsonResponse(
        page([row("overall-a", 1, 1500, "overall"), row("overall-b", 2, 1490, "overall"), row("overall-c", 7, 1480, "overall")])
      );
    }) as typeof fetch;

    await expect(fetchLmArenaTop("overall", { fetchFn, retryDelayMs: 0 })).rejects.toThrow(
      /category=overall via \/first-rows/
    );
  });

  it("propagates HTTP failures so the board can be reported as unavailable", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    await expect(fetchLmArenaTop("overall", { fetchFn, retryDelayMs: 0 })).rejects.toThrow(/500/);
    // 3 attempts on /rows plus 3 on the /first-rows fallback.
    expect(calls).toBe(6);
  });

  it("does not retry 4xx client errors", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    await expect(fetchLmArenaTop("overall", { fetchFn })).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it("caps the pages walked and reports observed categories when no candidate key appears", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse(page([row("model-x", 1, 1500, "coding")], 100_000));
    }) as typeof fetch;

    await expect(fetchLmArenaTop("overall", { fetchFn })).rejects.toThrow(
      /no rows for categories \[overall, text\].*observed categories: coding/
    );
    expect(calls).toBe(5);
  });

  it("fails closed when the fetched rows are not a consecutive rank run from 1", async () => {
    // Simulates a rank-descending snapshot of a 389-model board: page 1
    // holds ranks 389..290, so without the guard the daily post would show
    // the board's BOTTOM models as the TOP10.
    const descending = Array.from({ length: 100 }, (_unused, index) =>
      row(`model-${index + 1}`, 389 - index, 1500 - index, "overall")
    );
    const fetchFn = (async () => jsonResponse(page(descending, 389))) as typeof fetch;

    await expect(fetchLmArenaTop("overall", { fetchFn })).rejects.toThrow(
      /ranks are not the consecutive run 1\.\.100/
    );
  });

  it("distinguishes rows without a category column and stops paging", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input));
      // Rows without any category column (upstream schema drift).
      return jsonResponse(page([row("model-a", 1, 1500), row("model-b", 2, 1490)], 100_000));
    }) as typeof fetch;

    await expect(fetchLmArenaTop("overall", { fetchFn })).rejects.toThrow(
      /fetched 2 rows but none had a category column/
    );
    expect(urls).toHaveLength(1);
  });
});
