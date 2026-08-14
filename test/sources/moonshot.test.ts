import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fingerprint, sha256 } from "../../src/core/hash.js";
import type { SourceAdapterContext } from "../../src/domain/models.js";
import {
  createMoonshotAdapter,
  parseMoonshotModelsMarkdown
} from "../../src/sources/announcements/moonshot.js";

function fixture(): string {
  return readFileSync(new URL("./fixtures/moonshot-models.md", import.meta.url), "utf8");
}

function context(fetchFn: typeof fetch): SourceAdapterContext {
  return { fetch: fetchFn, now: new Date("2026-08-14T00:00:00.000Z") };
}

describe("Moonshot AI model catalogue", () => {
  it("parses active model tables while excluding notes and deprecated models", () => {
    const models = parseMoonshotModelsMarkdown(fixture());

    expect(models.map((model) => model.modelId)).toEqual([
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "moonshot-v1-8k",
      "moonshot-v1-8k-vision-preview"
    ]);
    expect(models.map((model) => model.modelId)).not.toContain("kimi-k2-thinking");
    expect(models.map((model) => model.modelId)).not.toContain("kimi-latest");
  });

  it("maps official catalogue rows directly to confirmed availability items", async () => {
    const body = fixture();
    const fetchFn = vi.fn(async () =>
      new Response(body, {
        headers: { "content-type": "text/markdown", etag: '"moonshot-v1"' }
      })
    ) as unknown as typeof fetch;

    const [snapshot] = await createMoonshotAdapter().poll(context(fetchFn));
    expect(snapshot).toMatchObject({
      kind: "announcements",
      sourceId: "moonshot",
      providerName: "Moonshot AI / Kimi",
      sourceUrl: "https://platform.kimi.ai/docs/models",
      observedAt: "2026-08-14T00:00:00.000Z",
      checkpoint: {
        etag: '"moonshot-v1"',
        contentHash: sha256(body)
      }
    });
    expect(snapshot?.items).toHaveLength(5);
    expect(snapshot?.checkpoint.revision).toBe(
      sha256(snapshot!.items.map((item) => item.modelIds[0] ?? "").join("\n"))
    );

    const coding = snapshot?.items.find((item) => item.modelIds[0] === "kimi-k2.7-code");
    expect(coding).toMatchObject({
      itemKey: fingerprint({ sourceId: "moonshot", key: "kimi-k2.7-code" }),
      title: "kimi-k2.7-code",
      url: "https://platform.kimi.ai/docs/models",
      modelIds: ["kimi-k2.7-code"],
      stage: "unknown",
      confidence: "confirmed",
      modality: "coding",
      eventKind: "availability"
    });
    expect(coding).not.toHaveProperty("publishedAt");

    expect(
      snapshot?.items.find(
        (item) => item.modelIds[0] === "moonshot-v1-8k-vision-preview"
      )
    ).toMatchObject({ stage: "preview", modality: "multimodal_text" });
  });

  it("uses HTTP validators and raw content hashes to skip unchanged polls", async () => {
    const body = fixture();
    let requestHeaders: Headers | undefined;
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(null, { status: 304, headers: { etag: '"moonshot-v1"' } });
      }
    ) as unknown as typeof fetch;
    const adapter = createMoonshotAdapter();

    await expect(
      adapter.poll({
        ...context(fetchFn),
        checkpoint: { etag: '"moonshot-v1"', contentHash: sha256(body) }
      })
    ).resolves.toEqual([]);
    expect(requestHeaders?.get("if-none-match")).toBe('"moonshot-v1"');

    const sameBodyFetch = vi.fn(async () =>
      new Response(body, { headers: { "content-type": "text/markdown" } })
    ) as unknown as typeof fetch;
    await expect(
      adapter.poll({
        ...context(sameBodyFetch),
        checkpoint: { contentHash: sha256(body) }
      })
    ).resolves.toEqual([]);
  });

  it("keeps item identity stable when only a description changes", async () => {
    const before = fixture();
    const after = before.replace(
      "Kimi's dedicated coding model for long-context software engineering and agent workflows.",
      "Kimi's dedicated coding model with improved long-context software engineering."
    );
    const poll = async (body: string) => {
      const fetchFn = (async () =>
        new Response(body, { headers: { "content-type": "text/markdown" } })) as typeof fetch;
      return (await createMoonshotAdapter().poll(context(fetchFn)))[0];
    };

    const beforeItem = (await poll(before))?.items.find(
      (item) => item.modelIds[0] === "kimi-k2.7-code"
    );
    const afterItem = (await poll(after))?.items.find(
      (item) => item.modelIds[0] === "kimi-k2.7-code"
    );
    expect(afterItem?.itemKey).toBe(beforeItem?.itemKey);
    expect(afterItem?.summary).not.toBe(beforeItem?.summary);
  });

  it("fails closed on missing, malformed, duplicate, or deprecated-only tables", () => {
    expect(() => parseMoonshotModelsMarkdown("# Models\n\nNo catalogue here.")).toThrow(
      /Model List heading/
    );
    expect(() =>
      parseMoonshotModelsMarkdown(`
# Model List
## Active Models
| Model Name | Description |
| not-a-separator | still-not-a-separator |
| \`kimi-k4\` | A text reasoning model. |
`)
    ).toThrow(/separator row/);
    expect(() =>
      parseMoonshotModelsMarkdown(`
# Model List
## Active Models
| Model Name | Description |
| --- | --- |
| \`kimi-k4\` | A text reasoning model. |
| \`kimi-k4\` | Duplicate row. |
`)
    ).toThrow(/duplicate model ID/);
    expect(() =>
      parseMoonshotModelsMarkdown(`
# Model List
## Deprecated Models
| Model Name | Description |
| --- | --- |
| \`kimi-k2\` | Deprecated. |
`)
    ).toThrow(/no active model table rows/);
  });

  it("keeps retired tables excluded when their heading level and wording change", () => {
    const models = parseMoonshotModelsMarkdown(`
# Model List
## Active Models
| Model Name | Description |
| --- | --- |
| \`kimi-k4\` | A frontier language model for reasoning. |
### No Longer Available
| Model Name | Description |
| --- | --- |
| \`kimi-k3-old\` | A retired language model. |
`);
    expect(models.map((model) => model.modelId)).toEqual(["kimi-k4"]);
  });

  it("excludes specialized non-generative and media-only catalogue rows", () => {
    const models = parseMoonshotModelsMarkdown(`
# Model List
## Active Models
| Model Name | Description |
| --- | --- |
| \`kimi-k4\` | A frontier language model for reasoning and Agent tasks. |
| \`kimi-embedding-v1\` | Embedding model for semantic search. |
| \`kimi-embeddings-v2\` | Text embeddings model for semantic search. |
| \`kimi-moderation-v1\` | Content moderation safety model. |
| \`kimi-audio-v1\` | Native audio voice model. |
| \`kimi-video-v1\` | Text-to-video generation model. |
| \`kimi-video-v2\` | A video generation model with advanced visual reasoning. |
| \`kimi-image-v2\` | An image generation model with reasoning over layout and style. |
| \`kimi-image-input-v1\` | An image generation model that outputs images from input text. |
| \`kimi-image-input-v2\` | An image generation model with visual reasoning that outputs images from image and text inputs. |
| \`kimi-image-input-v3\` | An image generation model with reasoning that returns images from visual and text inputs. |
| \`kimi-audio-v2\` | A voice model with agentic turn taking and no text output. |
`);
    expect(models.map((model) => model.modelId)).toEqual(["kimi-k4"]);
  });

  it("fails closed when a new catalogue category has no supported capability signal", () => {
    expect(() =>
      parseMoonshotModelsMarkdown(`
# Model List
## Active Models
| Model Name | Description |
| --- | --- |
| \`kimi-mystery-v1\` | A newly listed model for selected workloads. |
`)
    ).toThrow(/unrecognized capability/);
  });

  it("fails closed for an ambiguous media model without explicit text output", () => {
    expect(() =>
      parseMoonshotModelsMarkdown(`
# Model List
## Active Models
| Model Name | Description |
| --- | --- |
| \`kimi-vision-v2\` | A multimodal language model with advanced visual reasoning. |
`)
    ).toThrow(/unrecognized text-output capability/);
  });

  it("does not exclude supported models merely for mentioning safety or training", () => {
    const models = parseMoonshotModelsMarkdown(`
# Model List
## Active Models
| Model Name | Description |
| --- | --- |
| \`kimi-k4-safe\` | A frontier language model for reasoning with improved safety guardrails. |
| \`kimi-k4-reward\` | A coding agent with a new reward model training recipe. |
`);
    expect(models.map((model) => model.modelId)).toEqual([
      "kimi-k4-reward",
      "kimi-k4-safe"
    ]);
  });

  it("accepts mixed media models that explicitly return text in a compound output", () => {
    const models = parseMoonshotModelsMarkdown(`
# Model List
## Active Models
| Model Name | Description |
| --- | --- |
| \`kimi-image-v3\` | A multimodal language model supporting image generation that outputs both images and text. |
| \`kimi-image-v4\` | A multimodal language model returning images plus text. |
`);
    expect(models.map((model) => model.modelId)).toEqual([
      "kimi-image-v3",
      "kimi-image-v4"
    ]);
  });
});
