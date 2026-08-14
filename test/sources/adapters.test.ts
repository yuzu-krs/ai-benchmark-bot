import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import type { SourceAdapterContext } from "../../src/domain/models.js";
import { fetchResource, SourceHttpError } from "../../src/sources/http.js";
import { createSourceAdapters } from "../../src/sources/index.js";
import { LmArenaAdapter } from "../../src/sources/lmarena.js";

function context(fetchFn: typeof fetch): SourceAdapterContext {
  return { fetch: fetchFn, now: new Date("2026-08-14T00:00:00.000Z") };
}

function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
  ) as Record<string, unknown>;
}

describe("conditional source fetch", () => {
  it("sends validators and handles 304 without reading a body", async () => {
    let requestHeaders: Headers | undefined;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(null, {
        status: 304,
        headers: { etag: '"next"' }
      });
    }) as typeof fetch;

    const result = await fetchResource(fetchFn, "https://example.test/feed", {
      checkpoint: {
        etag: '"previous"',
        lastModified: "Wed, 12 Aug 2026 00:00:00 GMT",
        contentHash: "old"
      }
    });
    expect(result.status).toBe("not_modified");
    expect(requestHeaders?.get("if-none-match")).toBe('"previous"');
    expect(requestHeaders?.get("if-modified-since")).toBe(
      "Wed, 12 Aug 2026 00:00:00 GMT"
    );
  });

  it("returns only text plus validators and a deterministic content hash", async () => {
    const fetchFn = (async () =>
      new Response("fixture body", {
        headers: {
          "content-type": "text/plain",
          etag: '"abc"',
          "x-revision": "source-revision-7"
        }
      })) as typeof fetch;
    const result = await fetchResource(fetchFn, "https://example.test/feed");
    expect(result).toMatchObject({
      status: "ok",
      text: "fixture body",
      checkpoint: {
        etag: '"abc"',
        revision: "source-revision-7",
        contentHash: sha256("fixture body")
      }
    });
  });

  it("surfaces status and Retry-After for scheduler backoff", async () => {
    const fetchFn = (async () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "15" }
      })) as typeof fetch;
    const error = await fetchResource(fetchFn, "https://example.test/feed").catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(SourceHttpError);
    expect(error).toMatchObject({ status: 429, retryAfter: "15" });
  });

  it("aborts a source request that exceeds its configured deadline", async () => {
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true }
        );
      })) as typeof fetch;
    await expect(
      fetchResource(fetchFn, "https://example.test/hanging", { timeoutMs: 5 })
    ).rejects.toThrow();
  });
});

describe("source adapter registry", () => {
  it("keeps staged and terms-review sources disabled by default", () => {
    expect(createSourceAdapters().map((adapter) => adapter.id)).toEqual([
      "lmarena",
      "swebench",
      "openai",
      "anthropic",
      "google",
      "mistral",
      "xai",
      "deepseek"
    ]);
  });

  it("enables staged and terms-review sources independently", () => {
    const ids = createSourceAdapters({
      enableMeta: true,
      enableQwen: true,
      enableZai: true,
      enableMoonshot: true
    }).map(
      (adapter) => adapter.id
    );
    expect(ids).toContain("meta");
    expect(ids).toContain("qwen");
    expect(ids).toContain("zai");
    expect(ids).toContain("moonshot");
    expect(createSourceAdapters().every((adapter) => adapter.targets.length > 0)).toBe(true);
  });
});

describe("LMArena adapter", () => {
  it("uses the dataset SHA as a checkpoint before requesting any rows", async () => {
    const sha = "a".repeat(40);
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "lmarena-ai/leaderboard-dataset",
          sha,
          lastModified: "2026-08-12T00:00:00.000Z"
        }),
        { headers: { "content-type": "application/json" } }
      )
    ) as unknown as typeof fetch;
    const snapshots = await new LmArenaAdapter().poll({
      ...context(fetchFn),
      checkpoint: { revision: sha }
    });
    expect(snapshots).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fetches both categories and maps validated rows into snapshots", async () => {
    const sha = "b".repeat(40);
    const overallPage = fixtureJson("lmarena-page.json");
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "huggingface.co") {
        return new Response(
          JSON.stringify({
            id: "lmarena-ai/leaderboard-dataset",
            sha,
            lastModified: "2026-08-12T00:00:00.000Z"
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      const category = url.searchParams.get("where")?.includes("coding")
        ? "coding"
        : "overall";
      const page = structuredClone(overallPage) as {
        rows: Array<{ row: Record<string, unknown> }>;
        num_rows_total: number;
      };
      page.rows = page.rows.slice(0, 1);
      page.num_rows_total = 1;
      page.rows[0]!.row.category = category;
      page.rows[0]!.row.model_name = `${category}-model`;
      return new Response(JSON.stringify(page), {
        headers: { "content-type": "application/json", "x-revision": sha }
      });
    }) as unknown as typeof fetch;

    const snapshots = await new LmArenaAdapter().poll(context(fetchFn));
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((snapshot) => snapshot.leaderboardId)).toEqual([
      "lmarena-overall",
      "lmarena-coding"
    ]);
    expect(snapshots[0]?.entries[0]).toMatchObject({
      entityKey: "overall-model",
      score: 1450,
      scoreDisplay: "1450"
    });
    expect(snapshots[0]?.checkpoint).toMatchObject({ revision: sha });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("rejects filter rows when x-revision is missing", async () => {
    const sha = "c".repeat(40);
    const page = fixtureJson("lmarena-page.json");
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "huggingface.co") {
        return new Response(
          JSON.stringify({ id: "lmarena-ai/leaderboard-dataset", sha }),
          { headers: { "content-type": "application/json" } }
        );
      }
      const category = url.searchParams.get("where")?.includes("coding")
        ? "coding"
        : "overall";
      const responsePage = structuredClone(page) as {
        rows: Array<{ row: Record<string, unknown> }>;
        num_rows_total: number;
      };
      responsePage.rows = responsePage.rows.slice(0, 1);
      responsePage.num_rows_total = 1;
      responsePage.rows[0]!.row.category = category;
      responsePage.rows[0]!.row.model_name = `${category}-model`;
      return new Response(JSON.stringify(responsePage), {
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await expect(new LmArenaAdapter().poll(context(fetchFn))).rejects.toThrow(
      /missing the x-revision header/
    );
  });

  it("rejects filter rows from a different dataset revision", async () => {
    const metadataSha = "d".repeat(40);
    const staleSha = "e".repeat(40);
    const page = fixtureJson("lmarena-page.json");
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "huggingface.co") {
        return new Response(
          JSON.stringify({
            id: "lmarena-ai/leaderboard-dataset",
            sha: metadataSha
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      const category = url.searchParams.get("where")?.includes("coding")
        ? "coding"
        : "overall";
      const responsePage = structuredClone(page) as {
        rows: Array<{ row: Record<string, unknown> }>;
        num_rows_total: number;
      };
      responsePage.rows = responsePage.rows.slice(0, 1);
      responsePage.num_rows_total = 1;
      responsePage.rows[0]!.row.category = category;
      responsePage.rows[0]!.row.model_name = `${category}-model`;
      return new Response(JSON.stringify(responsePage), {
        headers: {
          "content-type": "application/json",
          "x-revision": staleSha
        }
      });
    }) as unknown as typeof fetch;

    await expect(new LmArenaAdapter().poll(context(fetchFn))).rejects.toThrow(
      new RegExp(`revision mismatch: metadata=${metadataSha}, page=${staleSha}`)
    );
  });
});
