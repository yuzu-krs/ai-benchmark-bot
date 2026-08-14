import type { SourceAdapter } from "../domain/models.js";
import { createAnthropicAdapter } from "./announcements/anthropic.js";
import { createDeepSeekAdapter } from "./announcements/deepseek.js";
import { createGoogleAdapter } from "./announcements/google.js";
import { createMetaAdapter } from "./announcements/meta.js";
import { createMistralAdapter } from "./announcements/mistral.js";
import { createOpenAiAdapter } from "./announcements/openai.js";
import { createQwenAdapter } from "./announcements/qwen.js";
import { createXaiAdapter } from "./announcements/xai.js";
import { createLmArenaAdapter } from "./lmarena.js";
import { createSweBenchAdapter } from "./swebench.js";

export interface SourceAdapterRegistryOptions {
  enableMeta?: boolean;
  enableQwen?: boolean;
}

export function createSourceAdapters(
  options: SourceAdapterRegistryOptions = {}
): SourceAdapter[] {
  const adapters: SourceAdapter[] = [
    createLmArenaAdapter(),
    createSweBenchAdapter(),
    createOpenAiAdapter(),
    createAnthropicAdapter(),
    createGoogleAdapter(),
    createMistralAdapter(),
    createXaiAdapter(),
    createDeepSeekAdapter()
  ];
  if (options.enableMeta === true) adapters.push(createMetaAdapter());
  if (options.enableQwen === true) adapters.push(createQwenAdapter());
  return adapters;
}

export { createLmArenaAdapter, LmArenaAdapter } from "./lmarena.js";
export { createSweBenchAdapter, SweBenchAdapter } from "./swebench.js";
export { createAnthropicAdapter } from "./announcements/anthropic.js";
export { createDeepSeekAdapter } from "./announcements/deepseek.js";
export { createGoogleAdapter } from "./announcements/google.js";
export { createMetaAdapter } from "./announcements/meta.js";
export { createMistralAdapter } from "./announcements/mistral.js";
export { createOpenAiAdapter } from "./announcements/openai.js";
export { createQwenAdapter } from "./announcements/qwen.js";
export { createXaiAdapter } from "./announcements/xai.js";
