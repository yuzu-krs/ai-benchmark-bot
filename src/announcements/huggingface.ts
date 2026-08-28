import type { RawAnnouncement } from "./classification.js";
import type { ProviderSource } from "./common.js";

/**
 * Generic source for labs that publish models straight to Hugging Face
 * (Qwen, Moonshot, Meta) instead of maintaining a changelog page: their org
 * model list, newest first, doubles as a release feed.
 */

interface HuggingFaceOrgSourceConfig {
  readonly id: string;
  readonly providerName: string;
  readonly org: string;
  readonly displayName: string;
}

/**
 * Quantization re-uploads (FP8/GGUF/…) and safety tooling (Guard) hit the
 * registry alongside real releases — often within minutes of the original
 * repo — and would double every notification if announced.
 */
const DERIVED_REPO_PATTERN = /(?:-(?:fp8|gguf|int4|int8|awq|gptq|mlx)(?:-|$)|-original$|guard)/i;

const REPOS_PER_POLL = 30;

export function parseHuggingFaceModelList(body: string): RawAnnouncement[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error("Hugging Face model list returned invalid JSON", { cause: error });
  }
  if (!Array.isArray(payload)) throw new Error("Hugging Face model list was not an array");

  const items: RawAnnouncement[] = [];
  for (const entry of payload) {
    const modelId = typeof entry?.modelId === "string" ? entry.modelId : undefined;
    if (!modelId) continue;
    const slashIndex = modelId.indexOf("/");
    const name = slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);
    const org = slashIndex === -1 ? "org" : modelId.slice(0, slashIndex);
    if (!name || DERIVED_REPO_PATTERN.test(name)) continue;
    const createdAt = typeof entry?.createdAt === "string" ? entry.createdAt : undefined;
    items.push({
      key: modelId,
      title: name,
      url: `https://huggingface.co/${modelId}`,
      ...(createdAt && Number.isFinite(Date.parse(createdAt)) ? { publishedAt: createdAt } : {}),
      summary: `New model repository published in the ${org} Hugging Face organization.`,
      // An official org repo IS an official release; the repo name carries
      // the model family the classifier keys on.
      officialModelEntry: true,
      modelIdHints: [modelId]
    });
  }
  if (items.length === 0) throw new Error("Hugging Face model list was empty");
  return items;
}

export function huggingFaceOrgSource(config: HuggingFaceOrgSourceConfig): ProviderSource {
  const url = new URL("https://huggingface.co/api/models");
  url.searchParams.set("author", config.org);
  url.searchParams.set("sort", "createdAt");
  url.searchParams.set("direction", "-1");
  url.searchParams.set("limit", String(REPOS_PER_POLL));
  return {
    id: config.id,
    providerName: config.providerName,
    displayName: config.displayName,
    fetchUrl: url.toString(),
    accept: "application/json",
    parse: parseHuggingFaceModelList
  };
}

export const qwenSource = huggingFaceOrgSource({
  id: "qwen",
  providerName: "Qwen",
  org: "Qwen",
  displayName: "Qwen Hugging Face releases"
});

export const moonshotSource = huggingFaceOrgSource({
  id: "moonshot",
  providerName: "Moonshot AI",
  org: "moonshotai",
  displayName: "Moonshot AI Hugging Face releases"
});

export const metaSource = huggingFaceOrgSource({
  id: "meta",
  providerName: "Meta",
  org: "meta-llama",
  displayName: "Meta Llama Hugging Face releases"
});
