import type {
  BenchmarkSnapshot,
  LeaderboardEntry,
  SourceAdapter,
  SourceAdapterContext
} from "../domain/models.js";
import { z } from "zod";
import { fetchResource, parseJson } from "./http.js";

const RAW_URL =
  "https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/master/data/leaderboards.json";
const SOURCE_URL =
  "https://github.com/SWE-bench/swe-bench.github.io/blob/master/data/leaderboards.json";

const resultSchema = z
  .object({
    name: z.string().trim().min(1),
    folder: z.string().trim().min(1),
    resolved: z.number().finite().min(0).max(100),
    checked: z.preprocess(
      (value) =>
        typeof value === "string" && /^false\s+\(see readme\.md/i.test(value)
          ? false
          : value,
      z.boolean().nullable().optional()
    ),
    date: z.string().trim().min(1).nullable().optional(),
    agent: z.string().trim().min(1).nullable().optional(),
    agent_org: z.string().trim().min(1).nullable().optional(),
    model_display: z.string().trim().min(1).nullable().optional(),
    model_org: z.string().trim().min(1).nullable().optional(),
    reasoning_effort: z.string().trim().min(1).nullable().optional(),
    os_model: z.boolean().optional(),
    os_system: z.boolean().optional(),
    warning: z.union([z.string(), z.null()]).optional()
  })
  .passthrough();

const rootSchema = z
  .object({
    leaderboards: z.array(
      z
        .object({
          name: z.string().trim().min(1),
          results: z.array(resultSchema)
        })
        .passthrough()
    )
  })
  .passthrough();

type SweBenchResult = z.infer<typeof resultSchema>;

export function parseSweBenchVerified(payload: unknown): SweBenchResult[] {
  const parsed = rootSchema.parse(payload);
  const matches = parsed.leaderboards.filter(
    (leaderboard) => leaderboard.name.toLowerCase() === "verified"
  );
  if (matches.length !== 1) {
    throw new Error(`SWE-bench expected one Verified leaderboard, found ${matches.length}`);
  }
  const results = matches[0]?.results.filter((result) => !result.warning) ?? [];
  if (results.length === 0) throw new Error("SWE-bench Verified leaderboard is empty");
  const folders = new Set(results.map((result) => result.folder));
  if (folders.size !== results.length) {
    throw new Error("SWE-bench Verified contains duplicate submission folders");
  }
  return results;
}

export function sweBenchEntries(results: SweBenchResult[]): LeaderboardEntry[] {
  const sorted = results
    .map((result) => ({ result, score: Math.round(result.resolved * 100) / 100 }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.result.name.localeCompare(b.result.name) ||
        a.result.folder.localeCompare(b.result.folder)
    );
  let previousScore: number | undefined;
  let previousRank = 0;
  return sorted.map(({ result, score }, index) => {
    const rank = previousScore === score ? previousRank : index + 1;
    previousScore = score;
    previousRank = rank;
    const metadata: Record<string, unknown> = { folder: result.folder };
    if (result.agent) metadata.agent = result.agent;
    if (result.agent_org) metadata.agentOrganization = result.agent_org;
    if (result.model_display) metadata.model = result.model_display;
    if (result.reasoning_effort) metadata.reasoningEffort = result.reasoning_effort;
    if (result.os_model !== undefined) metadata.openWeightsModel = result.os_model;
    if (result.os_system !== undefined) metadata.openSourceSystem = result.os_system;
    if (result.date) metadata.submissionDate = result.date;
    return {
      entityKey: result.folder,
      name: result.name,
      ...(result.agent_org || result.model_org
        ? { organization: result.agent_org ?? result.model_org ?? undefined }
        : {}),
      rank,
      score,
      scoreDisplay: `${score.toFixed(2)}%`,
      verified: result.checked === true,
      metadata
    };
  });
}

export class SweBenchAdapter implements SourceAdapter {
  readonly id = "swebench" as const;
  readonly displayName = "SWE-bench Verified";
  readonly intervalMinutes = 360;
  readonly targets = ["swebench-verified"] as const;

  async poll(context: SourceAdapterContext): Promise<BenchmarkSnapshot[]> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (context.githubToken) headers.authorization = `Bearer ${context.githubToken}`;
    const response = await fetchResource(context.fetch, RAW_URL, {
      checkpoint: context.checkpoint,
      headers
    });
    if (response.status === "not_modified") return [];
    if (response.checkpoint.contentHash === context.checkpoint?.contentHash) return [];

    const results = parseSweBenchVerified(parseJson(response.text, "SWE-bench"));
    const entries = sweBenchEntries(results);
    const sourceUpdatedAt = results
      .map((result) => result.date)
      .filter((date): date is string => Boolean(date))
      .sort()
      .at(-1);
    const checkpoint = {
      ...response.checkpoint,
      revision: response.checkpoint.contentHash
    };

    return [
      {
        kind: "benchmark",
        sourceId: "swebench",
        leaderboardId: "swebench-verified",
        leaderboardName: "SWE-bench Verified",
        category: "Verified",
        entityType: "submission",
        sourceUrl: SOURCE_URL,
        observedAt: context.now.toISOString(),
        ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
        version: "Verified",
        scorePrecision: 2,
        entries,
        checkpoint
      }
    ];
  }
}

export function createSweBenchAdapter(): SourceAdapter {
  return new SweBenchAdapter();
}
