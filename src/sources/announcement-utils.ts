import { fingerprint } from "../core/hash.js";
import type {
  AnnouncementItem,
  ReleaseStage,
  SourceId
} from "../domain/models.js";

export interface RawAnnouncement {
  key: string;
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
  modelIdHints?: string[];
  explicitModelIds?: string[];
  officialModelEntry?: boolean;
  authoritativeModelIds?: boolean;
}

interface Classification {
  confidence: "confirmed" | "candidate";
  modality: AnnouncementItem["modality"];
  modelIds: string[];
  stage: ReleaseStage;
}

const ID_SUFFIX = "[a-z0-9]+(?:\\.[a-z0-9]+)*";
const MODEL_TOKEN_SOURCE = [
  `gpt[-\\s]?\\d+(?:\\.\\d+)*(?:-${ID_SUFFIX}){0,4}`,
  `claude(?:[-\\s](?:opus|sonnet|haiku|fable|mythos))?[-\\s]?\\d+(?:\\.\\d+)*(?:-${ID_SUFFIX}){0,4}`,
  `gemini[-\\s]?\\d+(?:\\.\\d+)*(?:[-\\s](?:flash(?:-lite)?|pro|ultra|nano|robotics(?:-er)?|omni)){0,2}(?:-${ID_SUFFIX}){0,3}`,
  `grok[-\\s]?\\d+(?:\\.\\d+)*(?:-${ID_SUFFIX}){0,4}`,
  `deepseek[-\\s]?[rv]?\\d+(?:\\.\\d+)*(?:-${ID_SUFFIX}){0,4}`,
  `glm[-\\s]?\\d+(?:\\.\\d+)*v?(?:-${ID_SUFFIX}){0,4}`,
  `autoglm(?:[-\\s][a-z0-9]+){1,5}`,
  `kimi[-\\s]?k?\\d+(?:\\.\\d+)*(?:-${ID_SUFFIX}){0,5}`,
  `moonshot[-\\s]?v\\d+(?:\\.\\d+)*(?:-${ID_SUFFIX}){0,5}`,
  `llama[-\\s]?\\d+(?:\\.\\d+)*(?:-${ID_SUFFIX}){0,4}`,
  `qwen[-\\s]?\\d+(?:\\.\\d+)*(?:-${ID_SUFFIX}){0,5}`,
  `qwq[-\\s]?\\d+(?:\\.\\d+)*(?:-${ID_SUFFIX}){0,4}`,
  `mistral[-\\s]?\\d+(?:\\.\\d+)*(?:-${ID_SUFFIX}){0,4}`,
  `(?:mixtral|ministral|codestral|devstral|magistral|shieldstral|pixtral|robostral)(?:[-\\s]\\d+(?:\\.\\d+)*)?(?:-${ID_SUFFIX}){0,3}`,
  `muse[-\\s](?:spark|reason)(?:[-\\s]\\d+(?:\\.\\d+)*)?`
].join("|");
const MODEL_PATTERN = new RegExp(`\\b(?:${MODEL_TOKEN_SOURCE})\\b`, "i");
const MODEL_SCAN_PATTERN = new RegExp(`\\b(?:${MODEL_TOKEN_SOURCE})\\b`, "gi");
const EXPLICIT_ID_PATTERN =
  /^(?:[a-z][a-z0-9_.]*)(?:[-:][a-z0-9_.]+)+(?:\/[a-z0-9_.:-]+)?$/i;
const PRODUCT_FEATURE_PATTERN =
  /\b(?:api|endpoint|tools?|tokenizer|sdks?|cli|parameters?|headers?|budgets?|webhooks?|platform|console|billing|pricing|cach(?:e|ing)|diagnostics?|data residency|system messages?|fields?|files?|batch(?:ing)?|prompt caching|managed agents?|orchestration|compliance|workspaces?|fast mode|memory feature|rate limits?|structured outputs?|computer use|context (?:window|length)|retention|thinking|support(?:s|ed|ing)?|access|availability|aliases?|redirect(?:s|ed|ing)?|routing|session management|session resumption|reliability)\b/i;

export function buildAnnouncementItems(
  sourceId: SourceId,
  rawItems: RawAnnouncement[]
): AnnouncementItem[] {
  const seen = new Set<string>();
  const items: AnnouncementItem[] = [];

  for (const raw of rawItems) {
    const title = cleanText(raw.title, 180);
    const classificationSummary = raw.summary ? cleanText(raw.summary, 2_000) : undefined;
    const summary = raw.summary ? cleanText(raw.summary, 320) : undefined;
    if (!title || !isHttpUrl(raw.url)) continue;
    const classification = classifyAnnouncement(
      title,
      classificationSummary,
      raw.modelIdHints ?? [],
      raw.explicitModelIds ?? [],
      raw.officialModelEntry === true
    );
    if (!classification) continue;
    const itemKey = fingerprint({ sourceId, key: raw.key });
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);

    const item: AnnouncementItem = {
      itemKey,
      title,
      url: raw.url,
      modelIds: raw.authoritativeModelIds
        ? extractModelIds("", raw.modelIdHints ?? [], raw.explicitModelIds ?? [])
        : classification.modelIds,
      stage: classification.stage,
      confidence: classification.confidence,
      modality: classification.modality
    };
    if (raw.publishedAt) item.publishedAt = raw.publishedAt;
    if (summary) item.summary = summary;
    items.push(item);
  }
  return items.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}

export function classifyAnnouncement(
  title: string,
  summary = "",
  modelIdHints: string[] = [],
  explicitModelIds: string[] = [],
  officialModelEntry = false
): Classification | null {
  const text = cleanText(`${title} ${summary}`, 2_000);
  const lower = text.toLowerCase();
  const hasKnownFamily = MODEL_PATTERN.test(text);
  const recognizedHint = modelIdHints.some((hint) => MODEL_PATTERN.test(hint));
  const validExplicitModelIds = explicitModelIds.filter((modelId) =>
    EXPLICIT_ID_PATTERN.test(modelId.trim().replace(/^model:\s*/i, ""))
  );
  const hasDescribedModel =
    /\b(?:language|large language|multimodal|vision-language|reasoning|code|coding|foundation|frontier) models?\b/i.test(
      text
    ) || /\b\d+(?:\.\d+)?b\s+(?:open[- ]weights?\s+)?(?:multimodal\s+)?(?:\w+\s+)?model\b/i.test(text);
  const isModelRelated =
    hasKnownFamily || recognizedHint || validExplicitModelIds.length > 0 || hasDescribedModel;
  if (!isModelRelated) return null;

  const firstSentence = summary.split(/(?<=[.!?])\s/, 1)[0] ?? summary;
  const leadText = cleanText(`${title} ${firstSentence}`, 600);
  const titleForSignals = title.replace(/^OpenAI API entry:\s*/i, "");
  const hasProductFeatureLead = PRODUCT_FEATURE_PATTERN.test(leadText);
  const hasProductFeatureTitle = PRODUCT_FEATURE_PATTERN.test(titleForSignals);

  const directVerbThenModel = new RegExp(
    `\\b(?:introduc(?:e|ed|ing)|announc(?:e|ed|ing)|unveil(?:ed|ing)?|launch(?:ed|ing)?|releas(?:e|ed|ing))\\s+(?:(?:the|our|a|an|new|all-new|first|version|family|of|officially)\\s+){0,6}(?:${MODEL_TOKEN_SOURCE})\\b`,
    "i"
  ).test(text);
  const directModelThenAvailability = new RegExp(
    `\\b(?:${MODEL_TOKEN_SOURCE})\\b[^.!?\\n]{0,120}\\b(?:generally available|general availability|ga release|now available (?:on|through|via) (?:the )?(?:[a-z0-9 -]+ )?api|official(?:ly)? released|open[- ]weights?)\\b`,
    "i"
  ).test(text);
  const genericNamedModelLaunch =
    /\b(?:introduc(?:e|ed|ing)|announc(?:e|ed|ing)|unveil(?:ed|ing)?|launch(?:ed|ing)?|releas(?:e|ed|ing))\b[^.!?\n]{0,100}\b(?:new|latest|first|frontier|reasoning|language|coding|code|multimodal|preview|experimental|stable|open[- ]weights?) models?\b/i.test(
      text
    );
  const explicitIdLaunch = validExplicitModelIds.some((modelId) => {
    const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `\\b(?:introduc(?:e|ed|ing)|announc(?:e|ed|ing)|unveil(?:ed|ing)?|launch(?:ed|ing)?|releas(?:e|ed|ing))\\s+(?:(?:the|our|a|an|new|all-new|first|version|family|models?|of|officially)\\s+){0,6}${escaped}\\b`,
      "i"
    ).test(text);
  });
  const directNewModel =
    directVerbThenModel ||
    directModelThenAvailability ||
    explicitIdLaunch ||
    (genericNamedModelLaunch && !hasProductFeatureLead) ||
    (officialModelEntry && (recognizedHint || validExplicitModelIds.length > 0));

  const deprecation =
    /\b(?:deprecat(?:e|ed|ing|ion)|retir(?:e|ed|ing|ement)|sunset|shut(?:ting)? down|end of life)\b/i.test(
      text
    );
  const deprecationInTitle =
    /\b(?:deprecat(?:e|ed|ing|ion)|retir(?:e|ed|ing|ement)|sunset|shut(?:ting)? down|end of life)\b/i.test(
      title
    );
  if (deprecationInTitle || (deprecation && !directNewModel)) return null;

  const imageSpecificFamily =
    /\b(?:[a-z0-9]+(?:-[a-z0-9]+)*-image(?:-[a-z0-9.]+)*|gemini[-\s]\d+(?:\.\d+)*(?:[-\s](?:flash(?:[-\s]lite)?|pro))?[-\s]image|grok-imagine(?:-[a-z0-9.]+)*|qwen[-\s]?(?:vlo|image)(?:-[a-z0-9.]+)*|glm[-\s]?(?:image|ocr)(?:-[a-z0-9.]+)*|cogvideox?(?:-[a-z0-9.]+)*|nano banana(?:\s+\d+)?|imagen(?:[-\s]?\d+)?|veo(?:[-\s]?\d+)?|dall-e(?:[-\s]?\d+)?|sora(?:[-\s]?\d+)?)\b/i.test(
      text
    );
  const audioSpecificFamily =
    /\b(?:audio-to-audio|native audio(?: output| model)?|voice-first|speech(?:-to-speech| synthesis| recognition)|grok[-\s]voice|qwen[-\s]?(?:tts|asr)|glm[-\s]?asr(?:-[a-z0-9.]+)*|gemini[-\s][-a-z0-9.]*live(?:[-\s][a-z0-9.]+)*)\b/i.test(
      text
    );
  const mediaOnly =
    /\b(?:text-to-image|image generation|image editing|image output|drawing|text-to-video|video generation|video editing|speech-to-speech|text-to-speech|speech recognition|speech synthesis|transcription|voice model|tts|asr)\b/i.test(
      text
    ) || /\b(?:native visual|image|video|audio|speech|voice) models?\b/i.test(text);
  const specializedNonGenerative =
    /\b(?:embedding|embeddings|rerank|reranker|reranking|classifier|optical character recognition|\bocr\b|training method|reinforcement learning method)\b/i.test(
      text
    );
  const hasTextCapability =
    /\b(?:language models?|llm|vision-language|text(?:-only)? output|returns? text|generat(?:e|es|ing) text|responses? (?:in|as) (?:both )?text|text reasoning|coding|code models?|agents?|reasoning models?)\b/i.test(
      text
    );
  if (
    imageSpecificFamily ||
    audioSpecificFamily ||
    specializedNonGenerative ||
    (mediaOnly && !hasTextCapability)
  ) {
    return null;
  }
  const directModelInTitle = new RegExp(
    `\\b(?:introduc(?:e|ed|ing)|announc(?:e|ed|ing)|unveil(?:ed|ing)?|launch(?:ed|ing)?|releas(?:e|ed|ing))\\s+(?:(?:the|our|a|an|new|all-new|first|version|family|of|officially)\\s+){0,6}(?:${MODEL_TOKEN_SOURCE})\\b|\\b(?:${MODEL_TOKEN_SOURCE})\\b[^.!?\\n]{0,100}\\b(?:generally available|now available (?:on|through|via)|official(?:ly)? released|open[- ]weights?)\\b`,
    "i"
  ).test(titleForSignals);
  if ((hasProductFeatureTitle && !directModelInTitle) || (hasProductFeatureLead && !directNewModel)) {
    return null;
  }

  const ambiguousOutputFamily =
    /\b(?:omni|audio|live[-\s]?translate|vision|visual|image|video|voice|(?:^|[-\s])vl(?:[-\s]|$))\b/i.test(
      text
    );
  const inherentlyTextFamily =
    /(?:\b(?:gpt|claude|gemini|grok|deepseek|glm|autoglm|kimi|moonshot|llama|qwq|mistral|mixtral|ministral|codestral|devstral|magistral|muse[-\s]spark)\b|\bqwen\d*\b)/i.test(
      text
    );
  if (!hasTextCapability && !(inherentlyTextFamily && !ambiguousOutputFamily)) return null;

  const candidateNewModelSignal =
    /\b(?:(?:new|next-generation|unreleased|experimental|preview|research preview|release candidate)\s+(?:\w+\s+){0,3}models?|models?\s+(?:preview|release candidate|launch candidate|announcement candidate)|model announcement candidate)\b/i.test(
      leadText
    ) ||
    new RegExp(
      `\\b(?:${MODEL_TOKEN_SOURCE})\\b[^.!?\\n]{0,80}\\b(?:preview|experimental|release candidate|model launch|models? (?:is|are) live)\\b`,
      "i"
    ).test(leadText);
  if (!directNewModel && !candidateNewModelSignal) return null;

  let modality: AnnouncementItem["modality"] = "text";
  if (/\b(?:coding|code model|coder|codestral|devstral|software engineering)\b/i.test(text)) {
    modality = "coding";
  } else if (/\b(?:agents?|agentic|ai teammate|computer use|mobile automation|gui task)\b/i.test(text)) {
    modality = "agent";
  } else if (
    /\b(?:vision-language|image input|audio (?:and|with) text inputs?|visual reasoning|multimodal)\b/i.test(text) &&
    hasTextCapability
  ) {
    modality = "multimodal_text";
  }

  return {
    confidence: directNewModel ? "confirmed" : "candidate",
    modality,
    modelIds: extractModelIds(text, modelIdHints, validExplicitModelIds),
    stage: detectReleaseStage(lower)
  };
}

export function cleanText(value: string, maxLength: number): string {
  const cleaned = value.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function toIsoDate(value: string): string | undefined {
  const cleaned = cleanText(value, 200);
  let parseable = cleaned;
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    parseable = `${cleaned}T00:00:00.000Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(cleaned)) {
    parseable = `${cleaned}Z`;
  } else if (
    !/(?:[zZ]|[+-]\d{2}:?\d{2}|\b(?:UTC|GMT)\b)$/.test(cleaned) &&
    /(?:\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b|,\s*20\d{2}\b)/i.test(
      cleaned
    )
  ) {
    parseable = `${cleaned} UTC`;
  }
  const timestamp = Date.parse(parseable);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

export function absoluteUrl(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).toString();
}

export function recognizedModelIds(values: string[]): string[] {
  return extractModelIds("", values, []);
}

function extractModelIds(text: string, hints: string[], explicitIds: string[]): string[] {
  const values = new Set<string>();
  for (const explicitId of explicitIds) {
    const cleaned = explicitId.trim().replace(/^model:\s*/i, "");
    if (EXPLICIT_ID_PATTERN.test(cleaned)) {
      const normalized = normalizeModelId(cleaned);
      if (normalized) values.add(normalized);
    }
  }
  for (const hint of hints) {
    for (const match of hint.matchAll(MODEL_SCAN_PATTERN)) {
      const normalized = normalizeModelId(match[0]);
      if (normalized) values.add(normalized);
    }
  }
  for (const match of text.matchAll(MODEL_SCAN_PATTERN)) {
    const candidate = match[0];
    const normalized = normalizeModelId(candidate);
    if (normalized) values.add(normalized);
  }
  return [...values].sort();
}

function normalizeModelId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[()\[\],]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_.:/-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.:/]+|[-.:/]+$/g, "");
}

function detectReleaseStage(lower: string): ReleaseStage {
  if (/research preview/.test(lower)) return "research_preview";
  if (/open[- ]weights?|open source|open-source/.test(lower)) return "open_weights";
  if (/\b(?:preview|public beta|beta)\b/.test(lower)) return "preview";
  if (/\b(?:general availability|generally available|ga release|production-ready|now available|official(?:ly)? releas)\b/.test(lower)) {
    return "general_availability";
  }
  return "unknown";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
