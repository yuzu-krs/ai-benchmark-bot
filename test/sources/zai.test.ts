import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAnnouncementItems } from "../../src/sources/announcement-utils.js";
import {
  createZaiAdapter,
  parseZaiReleaseNotes
} from "../../src/sources/announcements/zai.js";

function fixture(): string {
  return readFileSync(new URL("./fixtures/zai.md", import.meta.url), "utf8");
}

describe("Z.ai release-note parser", () => {
  it("normalizes official Update blocks without following third-party links", () => {
    const entries = parseZaiReleaseNotes(fixture());

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      key: "model:glm-5.2",
      title: "GLM-5.2",
      url: "https://docs.z.ai/guides/llm/glm-5.2",
      publishedAt: "2026-06-16T00:00:00.000Z",
      modelIdHints: ["GLM-5.2"]
    });
    expect(entries[0]?.summary).toMatch(/^Z\.ai officially released GLM-5\.2\./);
    expect(entries[1]).toMatchObject({
      key: "model:glm-5v-turbo",
      url: "https://docs.z.ai/guides/vlm/glm-5v-turbo"
    });
    expect(entries[1]?.url).not.toContain("example.com");
    expect(entries[2]?.url).toBe("https://docs.z.ai/guides/image/glm-image");
  });

  it("keeps entry keys stable when bodies change or entries are reordered", () => {
    const original = parseZaiReleaseNotes(fixture());
    const changedSource = fixture()
      .replace(
        "Supports a 1M context window and improves long-horizon coding and agentic tasks.",
        "Now supports a 1M context window with stronger long-horizon execution."
      )
      .replace(
        /(<Update label="2026-06-16"[\s\S]*?<\/Update>)\n\n(<Update description="  GLM-5V-Turbo"[\s\S]*?<\/Update>)/,
        "$2\n\n$1"
      );
    const changed = parseZaiReleaseNotes(changedSource);

    expect(new Set(changed.map((entry) => entry.key))).toEqual(
      new Set(original.map((entry) => entry.key))
    );
    expect(changed.find((entry) => entry.title === "GLM-5.2")?.summary).not.toBe(
      original.find((entry) => entry.title === "GLM-5.2")?.summary
    );
  });

  it("classifies supported GLM releases, excludes media-only entries, and trusts title IDs", () => {
    const items = buildAnnouncementItems("zai", parseZaiReleaseNotes(fixture()));
    expect(items.map((item) => item.title)).toEqual(["GLM-5.2", "GLM-5V-Turbo"]);
    expect(items.find((item) => item.title === "GLM-5V-Turbo")).toMatchObject({
      confidence: "confirmed",
      modality: "coding",
      modelIds: ["glm-5v-turbo"]
    });
    expect(items.some((item) => item.title === "GLM-Image")).toBe(false);

    expect(
      buildAnnouncementItems("zai", [
        {
          key: "research-note",
          title: "Research process update",
          url: "https://docs.z.ai/release-notes/new-released",
          summary: "A training process was compared with Claude Opus 4.6.",
          modelIdHints: ["Research process update"],
          officialModelEntry: true,
          authoritativeModelIds: true
        }
      ])
    ).toEqual([]);
  });

  it("keeps text-capable vision, agent, and future model IDs from official entries", () => {
    const markdown = `
# New Released
## Models
<Update label="2026-01-01" description="GLM-4.6V">
  A multimodal large language model for images and text with visual reasoning.
</Update>
<Update label="2026-01-02" description="AutoGLM-Phone-Multilingual">
  A mobile automation framework that executes natural-language tasks across apps.
</Update>
<Update label="2026-01-03" description="Nova-1">
  A frontier language model for reasoning and coding.
</Update>`;
    const raw = parseZaiReleaseNotes(markdown);
    expect(raw.find((entry) => entry.title === "AutoGLM-Phone-Multilingual")).toMatchObject({
      explicitModelIds: ["AutoGLM-Phone-Multilingual"]
    });

    const items = buildAnnouncementItems("zai", raw);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "GLM-4.6V",
          modality: "multimodal_text",
          modelIds: ["glm-4.6v"]
        }),
        expect.objectContaining({
          title: "AutoGLM-Phone-Multilingual",
          modality: "agent",
          modelIds: ["autoglm-phone-multilingual"]
        }),
        expect.objectContaining({
          title: "Nova-1",
          modelIds: ["nova-1"]
        })
      ])
    );
  });

  it("ignores Update blocks outside the Models section", () => {
    const entries = parseZaiReleaseNotes(`
# New Released
## Models
<Update label="2026-01-01" description="GLM-6">
  A frontier language model for coding and reasoning.
</Update>
## Tools
<Update label="2026-01-02" description="Nova-Agent-Kit">
  An agent framework for coding tasks.
</Update>`);
    expect(entries.map((entry) => entry.title)).toEqual(["GLM-6"]);
    expect(buildAnnouncementItems("zai", entries)).toHaveLength(1);
  });

  it("keeps a model key stable when the publisher corrects its date", () => {
    const original = parseZaiReleaseNotes(fixture());
    const corrected = parseZaiReleaseNotes(
      fixture().replace('label="2026-06-16" description="  GLM-5.2"', 'label="2026-06-17" description="  GLM-5.2"')
    );
    expect(corrected[0]?.key).toBe(original[0]?.key);
    expect(corrected[0]?.publishedAt).not.toBe(original[0]?.publishedAt);
  });

  it.each([
    ["missing headings", '<Update label="2026-06-16" description="GLM-5.2">text</Update>'],
    ["missing entries", "# New Released\n\n## Models\n"],
    [
      "unclosed entry",
      '# New Released\n\n## Models\n<Update label="2026-06-16" description="GLM-5.2">text'
    ],
    [
      "invalid date",
      '# New Released\n\n## Models\n<Update label="June 16" description="GLM-5.2">text</Update>'
    ],
    [
      "missing title",
      '# New Released\n\n## Models\n<Update label="2026-06-16">text</Update>'
    ],
    [
      "unknown attribute",
      '# New Released\n\n## Models\n<Update label="2026-06-16" description="GLM-5.2" icon="code">text</Update>'
    ]
  ])("fails closed for %s", (_name, markdown) => {
    expect(() => parseZaiReleaseNotes(markdown)).toThrow(/Z\.ai release-note/);
  });

  it("constructs the hourly official Markdown adapter", () => {
    const adapter = createZaiAdapter();
    expect(adapter).toMatchObject({
      id: "zai",
      displayName: "Z.ai model release notes",
      intervalMinutes: 60,
      targets: ["provider-zai"]
    });
  });
});
