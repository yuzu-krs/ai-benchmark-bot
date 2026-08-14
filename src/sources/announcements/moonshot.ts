import { fingerprint, sha256 } from "../../core/hash.js";
import type {
  AnnouncementItem,
  AnnouncementSnapshot,
  SourceAdapter,
  SourceAdapterContext
} from "../../domain/models.js";
import { cleanText } from "../announcement-utils.js";
import { fetchResource } from "../http.js";

const SOURCE_URL = "https://platform.kimi.ai/docs/models";
const FETCH_URL = "https://platform.kimi.ai/docs/models.md";
const MAX_SOURCE_BYTES = 1024 * 1024;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const DEPRECATED_SECTION_PATTERN =
  /\b(?:deprecated|retired|discontinued|sunset|removed|unavailable|legacy|end of life)\b|\bno longer available\b/i;

export interface MoonshotCatalogModel {
  modelId: string;
  description: string;
  section: string;
}

/**
 * Parses only active model tables from Kimi's public, machine-readable model
 * catalogue. Notes and the Deprecated Models section deliberately do not count
 * as model availability records.
 */
export function parseMoonshotModelsMarkdown(markdown: string): MoonshotCatalogModel[] {
  const normalized = markdown.replace(/\r\n?/g, "\n").replace(/\p{Cf}/gu, "");
  if (!/^#\s+Model List\s*$/im.test(normalized)) {
    throw new Error("Moonshot model catalogue is missing the Model List heading");
  }

  const models: MoonshotCatalogModel[] = [];
  const seenModelIds = new Set<string>();
  let section = "";
  let deprecatedHeadingLevel: number | undefined;
  let tableSection: string | undefined;
  let expectsSeparator = false;
  let activeTableCount = 0;
  let activeRowCount = 0;

  for (const sourceLine of normalized.split("\n")) {
    const line = sourceLine.trim();
    const sectionMatch = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (sectionMatch) {
      const level = sectionMatch[1]?.length ?? 7;
      section = cleanText(sectionMatch[2] ?? "", 120);
      if (deprecatedHeadingLevel !== undefined && level <= deprecatedHeadingLevel) {
        deprecatedHeadingLevel = undefined;
      }
      if (DEPRECATED_SECTION_PATTERN.test(section)) deprecatedHeadingLevel = level;
      tableSection = undefined;
      expectsSeparator = false;
      continue;
    }

    if (!line.startsWith("|")) {
      if (line.length === 0) {
        tableSection = undefined;
        expectsSeparator = false;
      }
      continue;
    }

    const cells = splitMarkdownTableRow(line);
    if (isModelTableHeader(cells)) {
      tableSection = deprecatedHeadingLevel === undefined ? section : undefined;
      expectsSeparator = tableSection !== undefined;
      if (tableSection) activeTableCount += 1;
      continue;
    }

    if (!tableSection) continue;
    if (expectsSeparator) {
      if (!isTableSeparator(cells)) {
        throw new Error(`Moonshot model table in ${tableSection} has no separator row`);
      }
      expectsSeparator = false;
      continue;
    }

    if (cells.length < 2) {
      throw new Error(`Moonshot model table in ${tableSection} has a malformed row`);
    }
    const modelMatch = /^`([^`]+)`$/.exec(cells[0]?.trim() ?? "");
    if (!modelMatch) {
      throw new Error(`Moonshot model table in ${tableSection} has an invalid model ID cell`);
    }
    const modelId = (modelMatch[1] ?? "").trim().toLowerCase();
    if (!MODEL_ID_PATTERN.test(modelId)) {
      throw new Error(`Moonshot model catalogue contains an invalid model ID: ${modelId}`);
    }
    if (seenModelIds.has(modelId)) {
      throw new Error(`Moonshot model catalogue contains a duplicate model ID: ${modelId}`);
    }
    seenModelIds.add(modelId);
    activeRowCount += 1;

    const description = markdownToPlainText(cells.slice(1).join(" | "));
    if (!description) {
      throw new Error(`Moonshot model catalogue has no description for ${modelId}`);
    }
    if (!isSupportedModel(modelId, description, tableSection)) continue;
    models.push({ modelId, description, section: tableSection });
  }

  if (expectsSeparator) {
    throw new Error(`Moonshot model table in ${tableSection ?? "unknown section"} is incomplete`);
  }
  if (activeTableCount === 0 || activeRowCount === 0) {
    throw new Error("Moonshot model catalogue contains no active model table rows");
  }
  if (models.length === 0) {
    throw new Error("Moonshot model catalogue contains no supported active models");
  }

  return models.sort((left, right) => left.modelId.localeCompare(right.modelId));
}

export class MoonshotAdapter implements SourceAdapter {
  readonly id = "moonshot" as const;
  readonly displayName = "Moonshot AI / Kimi Model List";
  readonly intervalMinutes = 60;
  readonly targets = ["provider-moonshot"] as const;

  async poll(context: SourceAdapterContext): Promise<AnnouncementSnapshot[]> {
    const response = await fetchResource(context.fetch, FETCH_URL, {
      checkpoint: context.checkpoint,
      headers: { accept: "text/markdown, text/plain;q=0.9" },
      maxBytes: MAX_SOURCE_BYTES
    });
    if (response.status === "not_modified") return [];
    if (response.checkpoint.contentHash === context.checkpoint?.contentHash) return [];

    const models = parseMoonshotModelsMarkdown(response.text);
    const items = models.map(toAnnouncementItem);
    const revision = sha256(models.map((model) => model.modelId).join("\n"));

    return [
      {
        kind: "announcements",
        sourceId: this.id,
        providerName: "Moonshot AI / Kimi",
        sourceUrl: SOURCE_URL,
        observedAt: context.now.toISOString(),
        items,
        checkpoint: { ...response.checkpoint, revision }
      }
    ];
  }
}

export function createMoonshotAdapter(): MoonshotAdapter {
  return new MoonshotAdapter();
}

function toAnnouncementItem(model: MoonshotCatalogModel): AnnouncementItem {
  return {
    itemKey: fingerprint({ sourceId: "moonshot", key: model.modelId }),
    title: model.modelId,
    url: SOURCE_URL,
    summary: cleanText(model.description, 320),
    modelIds: [model.modelId],
    stage: /\b(?:preview|beta|experimental)\b/i.test(
      `${model.modelId} ${model.description}`
    )
      ? "preview"
      : "unknown",
    confidence: "confirmed",
    modality: detectModality(model),
    eventKind: "availability"
  };
}

function detectModality(model: MoonshotCatalogModel): AnnouncementItem["modality"] {
  const text = `${model.modelId} ${model.section} ${model.description}`;
  if (/\b(?:code|coding|coder|software engineering)\b/i.test(text)) return "coding";
  if (/\b(?:agent|agentic|tool[- ]calling)\b/i.test(text)) return "agent";
  if (/\b(?:multi[- ]?modal|vision|visual|image|video)\b/i.test(text)) {
    return "multimodal_text";
  }
  return "text";
}

function isSupportedModel(modelId: string, description: string, section: string): boolean {
  const text = `${modelId} ${description} ${section}`;
  const identity = `${modelId} ${section}`;
  const hasSupportedCapability =
    /\b(?:language models?|chat|dialogue|code|coding|software engineering|agents?|agentic|reasoning|knowledge work|generat(?:e|es|ing) (?:short |long |very long )?texts?|outputs? text|text output|returns? text)\b/i.test(
      text
    );
  const hasStrongTextOrAgentCapability =
    /\b(?:language models?|chat|dialogue|code|coding|software engineering|agents?|knowledge work|generat(?:e|es|ing) (?:short |long |very long )?texts?)\b/i.test(
      text
    );
  const specializedPattern =
    /\b(?:embeddings?|rerank(?:er|ers|ing)?|classifiers?|moderation|guardrails?|reward models?|safety models?|rankers?|scoring models?)\b/i;
  if (specializedPattern.test(identity)) return false;
  if (!hasSupportedCapability && specializedPattern.test(description)) return false;

  const mediaGenerator =
    /\b(?:text[- ]to[- ](?:image|video|speech)|image generation|video generation|audio generation|image editing|video editing|speech recognition|speech synthesis|voice model|tts|asr)\b/i.test(
      text
    );
  const mediaSpecificId =
    /(?:^|[-_.])(?:image|vision|video|audio|voice|tts|asr)(?:$|[-_.])/i.test(modelId);
  if (mediaGenerator || mediaSpecificId) {
    const explicitlyNoTextOutput =
      /\b(?:no|without)\s+text output\b|\bwithout (?:outputting|returning|producing) text\b|\bdoes not (?:output|return|respond with) text\b/i.test(
        description
      );
    const explicitTextOutput = hasExplicitTextOutput(description);
    if (explicitlyNoTextOutput) return false;
    if (!explicitTextOutput) {
      if (mediaGenerator && !hasStrongTextOrAgentCapability) return false;
      throw new Error(
        `Moonshot model catalogue has an unrecognized text-output capability for ${modelId}`
      );
    }
  }
  if (!hasSupportedCapability) {
    throw new Error(`Moonshot model catalogue has an unrecognized capability for ${modelId}`);
  }
  return true;
}

function hasExplicitTextOutput(description: string): boolean {
  if (/\btext (?:output|responses?)\b/i.test(description)) return true;

  const outputClauses = description.matchAll(
    /\b(?:outputs?|returns?|returning|responds?\s+(?:with|in))\b([^.!?\n]{0,100})/gi
  );
  for (const match of outputClauses) {
    const tail = match[1] ?? "";
    if (/^\s+(?:both\s+)?text\b(?!\s+(?:inputs?|prompts?))/i.test(tail)) return true;

    const compoundText =
      /(?:(?:and|plus|along with|as well as)\s+|,\s*)text\b(?!\s+(?:inputs?|prompts?))/i.exec(
        tail
      );
    if (!compoundText) continue;

    const beforeText = tail.slice(0, compoundText.index);
    if (/\b(?:from|using|based\s+on|given|inputs?|prompts?)\b/i.test(beforeText)) continue;
    return true;
  }
  return false;
}

function isModelTableHeader(cells: string[]): boolean {
  return (
    cells.length >= 2 &&
    /^model name$/i.test(cells[0]?.trim() ?? "") &&
    /^description$/i.test(cells[1]?.trim() ?? "")
  );
}

function isTableSeparator(cells: string[]): boolean {
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
}

function markdownToPlainText(value: string): string {
  return cleanText(
    value
      .replace(/\[([^\]]+)]\([^\s)]+(?:\s+"[^"]*")?\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/<[^>]+>/g, ""),
    600
  );
}
