import { fingerprint, newId, stableJson } from "../core/hash.js";
import type {
  BenchmarkSnapshot,
  DomainEvent,
  DomainEventPayload,
  EventType,
  LeaderboardEntry,
  SourceId
} from "./models.js";

const MAX_SCORE_PRECISION = 12;

export interface StoredEntryState extends LeaderboardEntry {
  active: boolean;
  missingCount: number;
}

export interface AnomalyResult {
  anomalous: boolean;
  reasons: string[];
  rowDropRatio: number;
  top50MovementRatio: number;
}

export interface EntryStateUpdate {
  entry: LeaderboardEntry;
  active: boolean;
  missingCount: number;
}

export interface BenchmarkDiffResult {
  events: DomainEvent[];
  updates: EntryStateUpdate[];
}

export function scoreAtPrecision(score: number, precision: number): number {
  if (!Number.isFinite(score)) throw new TypeError("score must be finite");
  if (!Number.isInteger(precision) || precision < 0 || precision > MAX_SCORE_PRECISION) {
    throw new RangeError(`scorePrecision must be between 0 and ${MAX_SCORE_PRECISION}`);
  }
  // toFixed follows the same visible decimal precision used by the source and
  // avoids treating invisible floating-point noise as a benchmark change.
  return Number(score.toFixed(precision));
}

export function normalizeLeaderboardEntries(
  entries: readonly LeaderboardEntry[],
  precision: number
): LeaderboardEntry[] {
  const seen = new Set<string>();
  return entries
    .map((entry) => {
      if (!entry.entityKey.trim()) throw new TypeError("entityKey must not be empty");
      if (seen.has(entry.entityKey)) {
        throw new TypeError(`duplicate entityKey: ${entry.entityKey}`);
      }
      if (!Number.isInteger(entry.rank) || entry.rank < 1) {
        throw new TypeError(`invalid rank for ${entry.entityKey}`);
      }
      seen.add(entry.entityKey);
      return {
        ...entry,
        score: scoreAtPrecision(entry.score, precision),
        metadata: entry.metadata ? { ...entry.metadata } : undefined
      };
    })
    .sort((left, right) => left.entityKey.localeCompare(right.entityKey));
}

export function benchmarkContentHash(snapshot: BenchmarkSnapshot): string {
  const entries = normalizeLeaderboardEntries(snapshot.entries, snapshot.scorePrecision).map(
    (entry) => ({
      entityKey: entry.entityKey,
      name: entry.name,
      organization: entry.organization,
      rank: entry.rank,
      score: entry.score,
      scoreDisplay: entry.scoreDisplay,
      verified: entry.verified,
      metadata: entry.metadata
    })
  );
  return fingerprint({
    leaderboardId: snapshot.leaderboardId,
    category: snapshot.category,
    entityType: snapshot.entityType,
    version: snapshot.version,
    scorePrecision: snapshot.scorePrecision,
    entries
  });
}

export function detectBenchmarkAnomaly(
  previous: readonly LeaderboardEntry[],
  current: readonly LeaderboardEntry[]
): AnomalyResult {
  if (previous.length === 0) {
    return {
      anomalous: current.length === 0,
      reasons: current.length === 0 ? ["empty snapshot"] : [],
      rowDropRatio: 0,
      top50MovementRatio: 0
    };
  }

  const rowDropRatio = Math.max(0, (previous.length - current.length) / previous.length);
  const currentByKey = new Map(current.map((entry) => [entry.entityKey, entry]));
  const previousTop50 = previous.filter((entry) => entry.rank <= 50);
  const moved = previousTop50.filter((entry) => {
    const next = currentByKey.get(entry.entityKey);
    return next === undefined || Math.abs(next.rank - entry.rank) >= 3;
  }).length;
  const top50MovementRatio = previousTop50.length === 0 ? 0 : moved / previousTop50.length;
  const reasons: string[] = [];
  if (rowDropRatio >= 0.2) reasons.push(`row count dropped ${(rowDropRatio * 100).toFixed(1)}%`);
  if (top50MovementRatio >= 0.3) {
    reasons.push(`top 50 large-movement ratio ${(top50MovementRatio * 100).toFixed(1)}%`);
  }
  return { anomalous: reasons.length > 0, reasons, rowDropRatio, top50MovementRatio };
}

export function isImmediateRankChange(oldRank: number, newRank: number): boolean {
  const crossedTop10 = (oldRank <= 10) !== (newRank <= 10);
  const materialTop50Move = Math.min(oldRank, newRank) <= 50 && Math.abs(newRank - oldRank) >= 3;
  return crossedTop10 || materialTop50Move;
}

export function createDomainEvent(input: {
  type: EventType;
  sourceId: SourceId;
  leaderboardId?: BenchmarkSnapshot["leaderboardId"];
  occurredAt: string;
  detectedAt: string;
  immediate: boolean;
  payload: DomainEventPayload;
  changeToken: string;
}): DomainEvent {
  const eventFingerprint = fingerprint({
    type: input.type,
    sourceId: input.sourceId,
    leaderboardId: input.leaderboardId,
    payload: input.payload,
    changeToken: input.changeToken
  });
  return {
    id: newId(),
    fingerprint: eventFingerprint,
    type: input.type,
    sourceId: input.sourceId,
    leaderboardId: input.leaderboardId,
    occurredAt: input.occurredAt,
    detectedAt: input.detectedAt,
    immediate: input.immediate,
    payload: input.payload
  };
}

export function diffBenchmarkEntries(input: {
  snapshot: BenchmarkSnapshot;
  current: readonly LeaderboardEntry[];
  priorStates: readonly StoredEntryState[];
  changeToken: string;
  baseline?: boolean;
  resetDefinition?: boolean;
}): BenchmarkDiffResult {
  const { snapshot, changeToken } = input;
  const occurredAt = snapshot.sourceUpdatedAt ?? snapshot.observedAt;
  const currentByKey = new Map(input.current.map((entry) => [entry.entityKey, entry]));
  const priorByKey = new Map(input.priorStates.map((entry) => [entry.entityKey, entry]));
  const events: DomainEvent[] = [];
  const updates: EntryStateUpdate[] = [];

  for (const entry of input.current) {
    const prior = priorByKey.get(entry.entityKey);
    updates.push({ entry, active: true, missingCount: 0 });
    if (input.baseline || input.resetDefinition) continue;

    if (!prior) {
      events.push(
        createDomainEvent({
          type: "benchmark.entity_first_seen",
          sourceId: snapshot.sourceId,
          leaderboardId: snapshot.leaderboardId,
          occurredAt,
          detectedAt: snapshot.observedAt,
          immediate: true,
          payload: {
            sourceId: snapshot.sourceId,
            leaderboardId: snapshot.leaderboardId,
            entityKey: entry.entityKey,
            entityName: entry.name,
            newRank: entry.rank,
            newScore: entry.score
          },
          changeToken
        })
      );
      continue;
    }

    if (!prior.active) continue;

    if (prior.rank !== entry.rank) {
      events.push(
        createDomainEvent({
          type: "benchmark.rank_changed",
          sourceId: snapshot.sourceId,
          leaderboardId: snapshot.leaderboardId,
          occurredAt,
          detectedAt: snapshot.observedAt,
          immediate: isImmediateRankChange(prior.rank, entry.rank),
          payload: {
            sourceId: snapshot.sourceId,
            leaderboardId: snapshot.leaderboardId,
            entityKey: entry.entityKey,
            entityName: entry.name,
            oldRank: prior.rank,
            newRank: entry.rank,
            oldScore: prior.score,
            newScore: entry.score
          },
          changeToken
        })
      );
    }

    if (prior.score !== entry.score) {
      events.push(
        createDomainEvent({
          type: "benchmark.score_changed",
          sourceId: snapshot.sourceId,
          leaderboardId: snapshot.leaderboardId,
          occurredAt,
          detectedAt: snapshot.observedAt,
          immediate: false,
          payload: {
            sourceId: snapshot.sourceId,
            leaderboardId: snapshot.leaderboardId,
            entityKey: entry.entityKey,
            entityName: entry.name,
            oldRank: prior.rank,
            newRank: entry.rank,
            oldScore: prior.score,
            newScore: entry.score
          },
          changeToken
        })
      );
    }

    if (prior.verified !== entry.verified) {
      events.push(
        createDomainEvent({
          type: "benchmark.verification_changed",
          sourceId: snapshot.sourceId,
          leaderboardId: snapshot.leaderboardId,
          occurredAt,
          detectedAt: snapshot.observedAt,
          immediate: true,
          payload: {
            sourceId: snapshot.sourceId,
            leaderboardId: snapshot.leaderboardId,
            entityKey: entry.entityKey,
            entityName: entry.name,
            verified: entry.verified,
            metadata: { oldVerified: prior.verified }
          },
          changeToken
        })
      );
    }
  }

  for (const prior of input.priorStates) {
    if (!prior.active || currentByKey.has(prior.entityKey)) continue;
    if (input.resetDefinition) {
      updates.push({ entry: prior, active: false, missingCount: 0 });
      continue;
    }
    const missingCount = prior.missingCount + 1;
    const removed = missingCount >= 2;
    updates.push({ entry: prior, active: !removed, missingCount: removed ? 0 : missingCount });
    if (!input.baseline && removed) {
      events.push(
        createDomainEvent({
          type: "benchmark.entity_removed",
          sourceId: snapshot.sourceId,
          leaderboardId: snapshot.leaderboardId,
          occurredAt,
          detectedAt: snapshot.observedAt,
          immediate: prior.rank <= 10,
          payload: {
            sourceId: snapshot.sourceId,
            leaderboardId: snapshot.leaderboardId,
            entityKey: prior.entityKey,
            entityName: prior.name,
            oldRank: prior.rank,
            oldScore: prior.score
          },
          changeToken: `${changeToken}:removal-confirmed`
        })
      );
    }
  }

  return { events, updates };
}

export function snapshotDefinition(snapshot: BenchmarkSnapshot): string {
  return stableJson({
    category: snapshot.category,
    entityType: snapshot.entityType,
    version: snapshot.version,
    scorePrecision: snapshot.scorePrecision
  });
}
