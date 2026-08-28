import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnthropicRss } from "../src/announcements/anthropic.js";
import { parseDeepSeekHtml } from "../src/announcements/deepseek.js";
import { parseGoogleChangelogHtml } from "../src/announcements/google.js";
import { parseHuggingFaceModelList } from "../src/announcements/huggingface.js";
import { parseMistralRss } from "../src/announcements/mistral.js";
import { parseOpenAiMarkdown } from "../src/announcements/openai.js";
import { parseXaiMarkdown } from "../src/announcements/xai.js";
import { parseZaiHtml } from "../src/announcements/zai.js";
import {
  buildAnnouncementItems,
  classifyAnnouncement,
  cleanText,
  toIsoDate
} from "../src/announcements/classification.js";
import { sha256 } from "../src/hash.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

interface ClassificationCase {
  name: string;
  title: string;
  summary: string;
  hints?: string[];
  explicit?: string[];
  expected: "confirmed" | "candidate" | null;
  modality?: "text" | "multimodal_text" | "coding" | "agent";
}

const classificationCases = JSON.parse(
  fixture("classification-live.json")
) as ClassificationCase[];

describe("official announcement fixture parsers", () => {
  it.each(classificationCases)("classifies live-derived case: $name", (testCase) => {
    const result = classifyAnnouncement(
      testCase.title,
      testCase.summary,
      testCase.hints ?? [],
      testCase.explicit ?? []
    );
    if (testCase.expected === null) {
      expect(result).toBeNull();
      return;
    }
    expect(result).toMatchObject({
      confidence: testCase.expected,
      ...(testCase.modality ? { modality: testCase.modality } : {})
    });
  });

  it("keeps an uncertain official model preview as a candidate", () => {
    const items = buildAnnouncementItems("google", [
      {
        key: "gemini-4-preview-update",
        title: "Gemini 4 model preview update",
        url: "https://ai.google.dev/gemini-api/docs/changelog",
        summary: "An early model preview is being evaluated with selected developers."
      }
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ confidence: "candidate", stage: "preview" });
  });

  it("parses and classifies OpenAI markdown", () => {
    const raw = parseOpenAiMarkdown(fixture("openai.md"));
    const items = buildAnnouncementItems("openai", raw);
    expect(raw).toHaveLength(2);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      confidence: "confirmed",
      modality: "coding",
      stage: "general_availability",
      publishedAt: "2026-08-07T00:00:00.000Z"
    });
    expect(items[0]?.modelIds).toContain("gpt-5.6-cyber");
  });

  it("keeps an existing OpenAI model item stable when another model is added that day", () => {
    const before = `
      ## August, 2026
      ### Aug 14
      Feature · Model: gpt-5.7-alpha

      We launched gpt-5.7-alpha, a new coding model.
    `.replace(/^ {6}/gm, "");
    const after = `
      ## August, 2026
      ### Aug 14
      Feature · Model: gpt-5.7-alpha · Model: gpt-5.7-beta

      We launched gpt-5.7-alpha and gpt-5.7-beta, two new coding models.
    `.replace(/^ {6}/gm, "");
    const beforeRaw = parseOpenAiMarkdown(before);
    const afterRaw = parseOpenAiMarkdown(after);
    expect(beforeRaw).toHaveLength(1);
    expect(afterRaw).toHaveLength(2);
    const alphaBefore = beforeRaw.find((entry) => entry.key.endsWith("model:gpt-5.7-alpha"));
    const alphaAfter = afterRaw.find((entry) => entry.key.endsWith("model:gpt-5.7-alpha"));
    expect(alphaAfter?.key).toBe(alphaBefore?.key);
    expect(alphaBefore?.title).toBe("OpenAI API entry: gpt-5.7-alpha — Aug 14");
    expect(buildAnnouncementItems("openai", afterRaw)).toHaveLength(2);
    expect(
      buildAnnouncementItems("openai", afterRaw).find((item) =>
        item.title.includes("gpt-5.7-alpha")
      )?.itemKey
    ).toBe(buildAnnouncementItems("openai", beforeRaw)[0]?.itemKey);
  });

  it("does not turn an OpenAI product feature into a model candidate through its parser title", () => {
    const markdown = `
      ## August, 2026
      ### Aug 15
      Feature · Model: gpt-5.7-preview

      We launched prompt caching and the Batch API for Model: gpt-5.7-preview.
    `.replace(/^ {6}/gm, "");
    const raw = parseOpenAiMarkdown(markdown);

    expect(raw).toHaveLength(1);
    expect(raw[0]?.title).toBe("OpenAI API entry: gpt-5.7-preview — Aug 15");
    expect(buildAnnouncementItems("openai", raw)).toEqual([]);
  });

  it("splits Anthropic release-note list items before classification", () => {
    const raw = parseAnthropicRss(fixture("anthropic.xml"));
    const items = buildAnnouncementItems("anthropic", raw);
    expect(raw).toHaveLength(2);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      confidence: "confirmed",
      modality: "text",
      stage: "general_availability"
    });
    expect(items[0]?.modelIds).toContain("claude-4-2-sonnet");
  });

  it("keeps Anthropic list entry keys stable when entries are prepended or reordered", () => {
    const originalXml = fixture("anthropic.xml").replace(/\r\n/g, "\n");
    const settingsEntry = "<li>The console now has a redesigned settings page.</li>";
    const modelEntry =
      "<li>We announced <code>claude-4-2-sonnet</code>, a new language model now available on the Claude API.</li>";
    const changedXml = originalXml.replace(
      `${settingsEntry}\n        ${modelEntry}`,
      `<li>A new billing export is available.</li>\n        ${modelEntry}\n        ${settingsEntry}`
    );
    const before = parseAnthropicRss(originalXml);
    const after = parseAnthropicRss(changedXml);
    expect(after).toHaveLength(3);

    const beforeKeys = new Map(before.map((entry) => [entry.summary, entry.key]));
    const afterKeys = new Map(after.map((entry) => [entry.summary, entry.key]));
    for (const entry of before) {
      expect(afterKeys.get(entry.summary)).toBe(beforeKeys.get(entry.summary));
      expect(entry.key).toBe(
        entry.modelIdHints?.includes("claude-4-2-sonnet")
          ? "anthropic-2026-08-10#models:claude-4-2-sonnet"
          : `anthropic-2026-08-10#${sha256(entry.summary ?? "")}`
      );
    }

    expect(buildAnnouncementItems("anthropic", after)[0]?.itemKey).toBe(
      buildAnnouncementItems("anthropic", before)[0]?.itemKey
    );

    const editedXml = originalXml.replace(
      "a new language model now available on the Claude API",
      "our newest language model, available now on the Claude API"
    );
    const editedModelEntry = parseAnthropicRss(editedXml).find((entry) =>
      entry.modelIdHints?.includes("claude-4-2-sonnet")
    );
    const originalModelEntry = before.find((entry) =>
      entry.modelIdHints?.includes("claude-4-2-sonnet")
    );
    expect(editedModelEntry?.key).toBe(originalModelEntry?.key);
  });

  it("parses Google changelog cards and excludes deprecations", () => {
    const raw = parseGoogleChangelogHtml(fixture("google.html"));
    const items = buildAnnouncementItems("google", raw);
    expect(raw).toHaveLength(2);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      confidence: "confirmed",
      modality: "coding",
      stage: "general_availability"
    });
    expect(items[0]?.url).toBe(
      "https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash"
    );
  });

  it("parses Mistral RSS and ignores general product news", () => {
    const raw = parseMistralRss(fixture("mistral.xml"));
    const items = buildAnnouncementItems("mistral", raw);
    expect(raw).toHaveLength(2);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ modality: "coding", stage: "open_weights" });
  });

  it("parses xAI markdown and excludes video-only models", () => {
    const raw = parseXaiMarkdown(fixture("xai.md"));
    const items = buildAnnouncementItems("xai", raw);
    expect(raw).toHaveLength(2);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ modality: "coding", confidence: "confirmed" });
    expect(items[0]?.url).toBe("https://x.ai/news/grok-4-6");
  });

  it("parses DeepSeek dated sections", () => {
    const raw = parseDeepSeekHtml(fixture("deepseek.html"));
    const items = buildAnnouncementItems("deepseek", raw);
    expect(raw).toHaveLength(2);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      publishedAt: "2026-08-13T00:00:00.000Z",
      stage: "general_availability",
      modality: "agent"
    });
  });

  it("parses Z.ai release-note entries and drops non-text models", () => {
    const raw = parseZaiHtml(fixture("zai.html"));
    const items = buildAnnouncementItems("zai", raw);
    // GLM-OCR is an OCR-family entry, which classification filters out.
    expect(raw).toHaveLength(3);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("GLM-5.3-Flash");
    expect(items[0]).toMatchObject({
      confidence: "confirmed",
      publishedAt: "2026-08-26T00:00:00.000Z",
      url: "https://docs.z.ai/guides/vlm/glm-5.3-flash"
    });
    expect(items[0]?.modelIds).toContain("glm-5.3-flash");
    expect(items[1]?.modelIds).toContain("glm-5.3");
    expect(items[1]?.url).toBe("https://docs.z.ai/guides/llm/glm-5.3");
  });

  it("parses Hugging Face org releases and drops quantization and guard repos", () => {
    const raw = parseHuggingFaceModelList(fixture("hf-models.json"));
    expect(raw.map((entry) => entry.title)).toEqual(["Qwen3.8-Flash-Next", "Kimi-K3"]);
    const items = buildAnnouncementItems("qwen", raw);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      confidence: "confirmed",
      publishedAt: "2026-08-24T08:24:59.000Z",
      url: "https://huggingface.co/Qwen/Qwen3.8-Flash-Next"
    });
    expect(items[0]?.modelIds).toContain("qwen3.8-flash-next");
    expect(items[1]?.modelIds).toContain("kimi-k3");
  });

  it("strips Unicode format characters before parsing DeepSeek dates and keys", () => {
    const html = `
      <main>
        <h2 id="date-2026-08-13">Date: 2026-08-13​</h2>
        <h3 id="deepseek-v4-pro-update">DeepSeek-V4-Pro Update⁠</h3>
        <p>We officially released DeepSeek-V4-Pro, a new agent reasoning model.</p>
      </main>`;
    const [entry] = parseDeepSeekHtml(html);
    expect(entry).toMatchObject({
      title: "DeepSeek-V4-Pro Update",
      publishedAt: "2026-08-13T00:00:00.000Z"
    });
    expect(entry?.key).not.toMatch(/\p{Cf}/u);
    expect(cleanText("Deep​Seek⁠ V4", 100)).toBe("DeepSeek V4");
  });

  it("normalizes timezone-free dates as UTC while respecting explicit offsets", () => {
    expect(toIsoDate("August 13, 2026")).toBe("2026-08-13T00:00:00.000Z");
    expect(toIsoDate("2026-08-13")).toBe("2026-08-13T00:00:00.000Z");
    expect(toIsoDate("2026-08-13T01:02:03")).toBe("2026-08-13T01:02:03.000Z");
    expect(toIsoDate("Mon, 10 Aug 2026 01:00:00 +0900")).toBe("2026-08-09T16:00:00.000Z");
  });

  it("fails closed when the official document shape disappears", () => {
    expect(() => parseGoogleChangelogHtml("<html></html>")).toThrow(/headings/);
    expect(() => parseOpenAiMarkdown("# Just a title")).toThrow(/sections/);
    expect(() => parseXaiMarkdown("# Release notes")).toThrow(/entries/);
    expect(() => parseZaiHtml("<html></html>")).toThrow(/entries/);
    expect(() => parseHuggingFaceModelList("not json")).toThrow(/invalid JSON/);
    expect(() => parseHuggingFaceModelList('{"nope": true}')).toThrow(/not an array/);
    expect(() => parseHuggingFaceModelList("[]")).toThrow(/empty/);
  });
});
