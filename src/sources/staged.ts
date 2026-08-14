export const STAGED_SOURCE_IDS = ["meta", "qwen"] as const;
export type StagedSourceId = (typeof STAGED_SOURCE_IDS)[number];

// Bump this whenever either staged parser's normalized contract changes. A new
// version deliberately requires a fresh seven-day observation window.
export const STAGED_CONTRACT_VERSION = "1";
export const REQUIRED_STAGED_CONTRACT_DAYS = 7;
