import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { drizzle } from "drizzle-orm/node-sqlite";

import type {
  BotStore,
  Delivery,
  GuildSettings,
  SnapshotResult,
  WatchTarget
} from "../application/ports.js";
import { fingerprint, newId } from "../core/hash.js";
import {
  benchmarkContentHash,
  createDomainEvent,
  detectBenchmarkAnomaly,
  diffBenchmarkEntries,
  normalizeLeaderboardEntries,
  snapshotDefinition,
  type EntryStateUpdate,
  type StoredEntryState
} from "../domain/diff.js";
import {
  SOURCE_IDS,
  WATCH_TARGETS,
  type AnnouncementItem,
  type AnnouncementSnapshot,
  type BenchmarkSnapshot,
  type DomainEvent,
  type EventType,
  type LeaderboardEntry,
  type LeaderboardId,
  type SourceCheckpoint,
  type SourceId,
  type SourceSnapshot,
  type SourceStatus
} from "../domain/models.js";
import { applyMigrations } from "./migrations.js";

type SqliteValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, unknown>;
type PhaseTwoSourceId = "meta" | "qwen";

interface LeaderboardRow extends Row {
  id: string;
  source_id: string;
  name: string;
  category: string;
  entity_type: string;
  source_url: string;
  version: string;
  score_precision: number;
  definition_json: string;
  current_snapshot_id: string | null;
  pending_anomaly_snapshot_id: string | null;
  pending_anomaly_hash: string | null;
  pending_anomaly_count: number;
  updated_at: string;
}

interface SnapshotRow extends Row {
  id: string;
  content_hash: string;
  status: string;
  observed_at: string;
}

interface EventRow extends Row {
  id: string;
  fingerprint: string;
  type: EventType;
  source_id: SourceId;
  leaderboard_id: LeaderboardId | null;
  occurred_at: string;
  detected_at: string;
  immediate: number;
  payload_json: string;
}

function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  return Number(value) !== 0;
}

function changes(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

function validLimit(value: number, maximum = 1000): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError("limit must be a positive integer");
  return Math.min(value, maximum);
}

function defaultWatchEnabled(target: string): boolean {
  return target !== "provider-meta" && target !== "provider-qwen";
}

function validatePhaseTwoSource(sourceId: string): asserts sourceId is PhaseTwoSourceId {
  if (sourceId !== "meta" && sourceId !== "qwen") {
    throw new RangeError(`contract checks are unsupported for source: ${sourceId}`);
  }
}

function validateDateKey(dateKey: string, fieldName = "dateKey"): string {
  if (typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new TypeError(`${fieldName} must use YYYY-MM-DD`);
  }
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateKey) {
    throw new TypeError(`${fieldName} is not a valid calendar date`);
  }
  return dateKey;
}

function validateContractVersion(contractVersion: string): string {
  if (typeof contractVersion !== "string") throw new TypeError("contractVersion must be a string");
  const normalized = contractVersion.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new RangeError("contractVersion must contain 1 to 200 characters");
  }
  return normalized;
}

function normalizeCheckedAt(checkedAt: string): string {
  if (typeof checkedAt !== "string") throw new TypeError("checkedAt must be a timestamp string");
  const timestamp = new Date(checkedAt);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError("checkedAt must be a valid timestamp");
  return timestamp.toISOString();
}

function priorDateKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function announcementContentHash(snapshot: AnnouncementSnapshot): string {
  return fingerprint({
    sourceId: snapshot.sourceId,
    items: [...snapshot.items]
      .map((item) => ({
        itemKey: item.itemKey,
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt,
        summary: item.summary,
        modelIds: [...item.modelIds].sort(),
        stage: item.stage,
        confidence: item.confidence,
        modality: item.modality
      }))
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey))
  });
}

function benchmarkRevisionToken(snapshot: BenchmarkSnapshot, contentHash: string): string {
  return (
    snapshot.checkpoint.revision ??
    snapshot.sourceUpdatedAt ??
    snapshot.checkpoint.lastModified ??
    `${contentHash}:${snapshot.observedAt}`
  );
}

function eventFromRow(row: EventRow): DomainEvent {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    type: row.type,
    sourceId: row.source_id,
    leaderboardId: row.leaderboard_id ?? undefined,
    occurredAt: String(row.occurred_at),
    detectedAt: String(row.detected_at),
    immediate: Number(row.immediate) !== 0,
    payload: jsonParse(row.payload_json, { sourceId: row.source_id })
  };
}

export class SqliteBotStore implements BotStore {
  private readonly sqlite: DatabaseSync;

  // Keeping the Drizzle handle beside the synchronous SQLite connection gives
  // schema-aware consumers a single driver while latency-sensitive store
  // transactions use prepared SQL directly.
  readonly orm: ReturnType<typeof drizzle>;

  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.sqlite = new DatabaseSync(databasePath);
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec("PRAGMA busy_timeout = 5000");
    this.sqlite.exec("PRAGMA journal_mode = WAL");
    this.sqlite.exec("PRAGMA synchronous = NORMAL");
    applyMigrations(this.sqlite);
    this.orm = drizzle({ client: this.sqlite });
  }

  close(): void {
    this.sqlite.close();
  }

  syncActiveSources(sourceIds: readonly SourceId[], updatedAt: string): void {
    const active = new Set(sourceIds);
    for (const sourceId of active) {
      if (!SOURCE_IDS.includes(sourceId)) throw new RangeError(`unknown source: ${sourceId}`);
    }
    this.transaction(() => {
      const statement = this.sqlite.prepare(
        `INSERT INTO source_state (source_id, enabled, consecutive_failures, health, updated_at)
         VALUES (?, ?, 0, 'healthy', ?)
         ON CONFLICT(source_id) DO UPDATE SET
           enabled = excluded.enabled,
           next_poll_at = CASE
             WHEN source_state.enabled = 0 AND excluded.enabled = 1 THEN NULL
             ELSE source_state.next_poll_at
           END,
           updated_at = excluded.updated_at`
      );
      for (const sourceId of SOURCE_IDS) {
        statement.run(sourceId, active.has(sourceId) ? 1 : 0, updatedAt);
      }
    });
  }

  recordAdapterContractCheck(
    sourceId: PhaseTwoSourceId,
    dateKey: string,
    checkedAt: string,
    success: boolean,
    contractVersion: string,
    errorMessage?: string
  ): void {
    validatePhaseTwoSource(sourceId);
    const normalizedDateKey = validateDateKey(dateKey);
    const normalizedCheckedAt = normalizeCheckedAt(checkedAt);
    const normalizedVersion = validateContractVersion(contractVersion);
    if (typeof success !== "boolean") throw new TypeError("success must be a boolean");
    if (errorMessage !== undefined && typeof errorMessage !== "string") {
      throw new TypeError("errorMessage must be a string when provided");
    }
    if (errorMessage !== undefined && errorMessage.length > 2000) {
      throw new RangeError("errorMessage must not exceed 2000 characters");
    }

    this.sqlite
      .prepare(
        `INSERT INTO adapter_contract_checks
           (source_id, date_key, checked_at, success, contract_version, error_message)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, date_key) DO UPDATE SET
           checked_at = excluded.checked_at,
           success = excluded.success,
           contract_version = excluded.contract_version,
           error_message = excluded.error_message
         WHERE excluded.checked_at >= adapter_contract_checks.checked_at`
      )
      .run(
        sourceId,
        normalizedDateKey,
        normalizedCheckedAt,
        success ? 1 : 0,
        normalizedVersion,
        success ? null : (errorMessage ?? null)
      );
  }

  getAdapterContractStreak(
    sourceId: PhaseTwoSourceId,
    throughDateKey: string,
    contractVersion: string
  ): number {
    validatePhaseTwoSource(sourceId);
    const normalizedThroughDateKey = validateDateKey(throughDateKey, "throughDateKey");
    const normalizedVersion = validateContractVersion(contractVersion);
    const rows = this.all<Row>(
      `SELECT date_key, success, contract_version
         FROM adapter_contract_checks
        WHERE source_id = ? AND date_key <= ?
        ORDER BY date_key ASC`,
      sourceId,
      normalizedThroughDateKey
    );
    let currentStreak = 0;
    let maximumStreak = 0;
    let previousDateKey: string | undefined;
    for (const row of rows) {
      const rowDateKey = String(row.date_key);
      const followsPrevious =
        previousDateKey !== undefined && priorDateKey(rowDateKey) === previousDateKey;
      if (Number(row.success) === 1 && String(row.contract_version) === normalizedVersion) {
        currentStreak = followsPrevious ? currentStreak + 1 : 1;
        maximumStreak = Math.max(maximumStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
      previousDateKey = rowDateKey;
    }
    return maximumStreak;
  }

  private transaction<T>(work: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private one<T extends Row>(sql: string, ...params: SqliteValue[]): T | undefined {
    return this.sqlite.prepare(sql).get(...params) as T | undefined;
  }

  private all<T extends Row>(sql: string, ...params: SqliteValue[]): T[] {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }

  private insertEvent(event: DomainEvent): DomainEvent | undefined {
    const inserted = changes(
      this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO events
            (id, fingerprint, type, source_id, leaderboard_id, occurred_at, detected_at,
             immediate, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.id,
          event.fingerprint,
          event.type,
          event.sourceId,
          event.leaderboardId ?? null,
          event.occurredAt,
          event.detectedAt,
          event.immediate ? 1 : 0,
          JSON.stringify(event.payload),
          event.detectedAt
        )
    );
    return inserted === 1 ? event : undefined;
  }

  private insertEvents(events: readonly DomainEvent[]): DomainEvent[] {
    const inserted: DomainEvent[] = [];
    for (const event of events) {
      const result = this.insertEvent(event);
      if (result) inserted.push(result);
    }
    return inserted;
  }

  getSourceStatus(sourceId: SourceId): SourceStatus | undefined {
    const row = this.one<Row>("SELECT * FROM source_state WHERE source_id = ?", sourceId);
    if (!row) return undefined;
    return this.sourceStatusFromRow(row, sourceId);
  }

  listSourceStatuses(): SourceStatus[] {
    const rows = this.all<Row>("SELECT * FROM source_state");
    const byId = new Map(rows.map((row) => [String(row.source_id), row]));
    return SOURCE_IDS.map((sourceId) => {
      const row = byId.get(sourceId);
      return row
        ? this.sourceStatusFromRow(row, sourceId)
        : {
            sourceId,
            enabled: sourceId !== "meta" && sourceId !== "qwen",
            consecutiveFailures: 0,
            health: "healthy"
          };
    });
  }

  private sourceStatusFromRow(row: Row, sourceId: SourceId): SourceStatus {
    return {
      sourceId,
      enabled: Number(row.enabled) !== 0,
      lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : undefined,
      lastSuccessAt: row.last_success_at ? String(row.last_success_at) : undefined,
      nextPollAt: row.next_poll_at ? String(row.next_poll_at) : undefined,
      consecutiveFailures: Number(row.consecutive_failures),
      health: row.health === "degraded" ? "degraded" : "healthy",
      checkpoint: row.checkpoint_json
        ? jsonParse<SourceCheckpoint>(row.checkpoint_json, {})
        : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined
    };
  }

  markSourceAttempt(sourceId: SourceId, attemptedAt: string): void {
    this.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO source_state
             (source_id, enabled, last_attempt_at, consecutive_failures, health, updated_at)
           VALUES (?, 1, ?, 0, 'healthy', ?)
           ON CONFLICT(source_id) DO UPDATE SET
             last_attempt_at = excluded.last_attempt_at,
             updated_at = excluded.updated_at`
        )
        .run(sourceId, attemptedAt, attemptedAt);
      this.sqlite
        .prepare(
          `INSERT INTO source_poll_logs
             (id, source_id, attempted_at, status)
           VALUES (?, ?, ?, 'attempted')`
        )
        .run(newId(), sourceId, attemptedAt);
    });
  }

  markSourceSuccess(
    sourceId: SourceId,
    succeededAt: string,
    nextPollAt: string,
    checkpoint: Record<string, unknown>
  ): DomainEvent[] {
    return this.transaction(() => {
      const prior = this.getSourceStatus(sourceId);
      this.sqlite
        .prepare(
          `INSERT INTO source_state
             (source_id, enabled, last_attempt_at, last_success_at, next_poll_at,
              consecutive_failures, health, checkpoint_json, last_error, updated_at)
           VALUES (?, 1, ?, ?, ?, 0, 'healthy', ?, NULL, ?)
           ON CONFLICT(source_id) DO UPDATE SET
             last_success_at = excluded.last_success_at,
             next_poll_at = excluded.next_poll_at,
             consecutive_failures = 0,
             health = 'healthy',
             checkpoint_json = excluded.checkpoint_json,
             last_error = NULL,
             updated_at = excluded.updated_at`
        )
        .run(sourceId, succeededAt, succeededAt, nextPollAt, JSON.stringify(checkpoint), succeededAt);
      this.completeLatestPollLog(sourceId, succeededAt, "success");

      if (prior?.health !== "degraded") return [];
      const event = createDomainEvent({
        type: "source.recovered",
        sourceId,
        occurredAt: succeededAt,
        detectedAt: succeededAt,
        immediate: true,
        payload: { sourceId, reason: "source poll succeeded after degradation" },
        changeToken: succeededAt
      });
      const inserted = this.insertEvent(event);
      return inserted ? [inserted] : [];
    });
  }

  markSourceFailure(
    sourceId: SourceId,
    failedAt: string,
    nextPollAt: string,
    errorMessage: string
  ): DomainEvent[] {
    return this.transaction(() => {
      const prior = this.getSourceStatus(sourceId);
      const failureCount = (prior?.consecutiveFailures ?? 0) + 1;
      const degraded = failureCount >= 3;
      this.sqlite
        .prepare(
          `INSERT INTO source_state
             (source_id, enabled, last_attempt_at, next_poll_at, consecutive_failures,
              health, last_error, updated_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_id) DO UPDATE SET
             next_poll_at = excluded.next_poll_at,
             consecutive_failures = excluded.consecutive_failures,
             health = excluded.health,
             last_error = excluded.last_error,
             updated_at = excluded.updated_at`
        )
        .run(
          sourceId,
          failedAt,
          nextPollAt,
          failureCount,
          degraded ? "degraded" : "healthy",
          errorMessage.slice(0, 2000),
          failedAt
        );
      this.completeLatestPollLog(sourceId, failedAt, "failure", errorMessage.slice(0, 2000));

      if (!degraded || prior?.health === "degraded") return [];
      const event = createDomainEvent({
        type: "source.degraded",
        sourceId,
        occurredAt: failedAt,
        detectedAt: failedAt,
        immediate: true,
        payload: { sourceId, reason: `3 consecutive failures: ${errorMessage.slice(0, 500)}` },
        changeToken: failedAt
      });
      const inserted = this.insertEvent(event);
      return inserted ? [inserted] : [];
    });
  }

  private completeLatestPollLog(
    sourceId: SourceId,
    completedAt: string,
    status: "success" | "failure",
    errorMessage?: string
  ): void {
    const result = this.sqlite
      .prepare(
        `UPDATE source_poll_logs
            SET completed_at = ?, status = ?, error_message = ?
          WHERE id = (
            SELECT id FROM source_poll_logs
             WHERE source_id = ? AND status = 'attempted'
             ORDER BY attempted_at DESC LIMIT 1
          )`
      )
      .run(completedAt, status, errorMessage ?? null, sourceId);
    if (changes(result) === 0) {
      this.sqlite
        .prepare(
          `INSERT INTO source_poll_logs
             (id, source_id, attempted_at, completed_at, status, error_message)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(newId(), sourceId, completedAt, completedAt, status, errorMessage ?? null);
    }
  }

  processSnapshot(snapshot: SourceSnapshot): SnapshotResult {
    return snapshot.kind === "benchmark"
      ? this.processBenchmarkSnapshot(snapshot)
      : this.processAnnouncementSnapshot(snapshot);
  }

  confirmUnchangedSource(sourceId: SourceId, observedAt: string): DomainEvent[] {
    return this.transaction(() => {
      const missing = this.all<Row>(
        `SELECT e.entity_key, e.name, e.last_rank, e.last_score,
                l.id AS leaderboard_id, s.content_hash
           FROM entities e
           JOIN leaderboards l ON l.id = e.leaderboard_id
           JOIN snapshots s ON s.id = l.current_snapshot_id
          WHERE l.source_id = ? AND e.active = 1 AND e.missing_count = 1`,
        sourceId
      );
      const events: DomainEvent[] = [];
      for (const row of missing) {
        const updated = this.sqlite
          .prepare(
            `UPDATE entities SET active = 0, missing_count = 0, updated_at = ?
              WHERE leaderboard_id = ? AND entity_key = ? AND active = 1 AND missing_count = 1`
          )
          .run(observedAt, String(row.leaderboard_id), String(row.entity_key));
        if (changes(updated) !== 1) continue;
        const leaderboardId = String(row.leaderboard_id) as LeaderboardId;
        events.push(
          createDomainEvent({
            type: "benchmark.entity_removed",
            sourceId,
            leaderboardId,
            occurredAt: observedAt,
            detectedAt: observedAt,
            immediate: Number(row.last_rank) <= 10,
            payload: {
              sourceId,
              leaderboardId,
              entityKey: String(row.entity_key),
              entityName: String(row.name),
              oldRank: Number(row.last_rank),
              oldScore: Number(row.last_score)
            },
            changeToken: `${String(row.content_hash)}:removal-confirmed`
          })
        );
      }
      return this.insertEvents(events);
    });
  }

  private processBenchmarkSnapshot(snapshot: BenchmarkSnapshot): SnapshotResult {
    const current = normalizeLeaderboardEntries(snapshot.entries, snapshot.scorePrecision);
    const contentHash = benchmarkContentHash({ ...snapshot, entries: current });
    const revisionToken = benchmarkRevisionToken(snapshot, contentHash);
    return this.transaction(() => {
      const leaderboard = this.ensureLeaderboard(snapshot);
      const previousEntries = leaderboard.current_snapshot_id
        ? this.snapshotEntries(leaderboard.current_snapshot_id)
        : [];
      const priorStates = this.entryStates(snapshot.leaderboardId);
      const baseline = leaderboard.current_snapshot_id === null;

      // Empty payloads are never promoted, even on repetition. They almost
      // always indicate a remote schema/parser failure and must not erase a
      // healthy baseline.
      if (current.length === 0) {
        const newlyQuarantined = leaderboard.pending_anomaly_hash !== contentHash;
        if (newlyQuarantined) {
          const snapshotId = this.insertSnapshot(snapshot, contentHash, "quarantined", "empty snapshot");
          this.setPendingAnomaly(snapshot.leaderboardId, snapshotId, contentHash, 1, snapshot.observedAt);
        }
        return { baseline: false, changed: newlyQuarantined, quarantined: true, events: [] };
      }

      const definition = snapshotDefinition(snapshot);
      const definitionChanged = !baseline && leaderboard.definition_json !== definition;
      if (definitionChanged) {
        const snapshotId = this.insertSnapshot(snapshot, contentHash, "accepted");
        const stateDiff = diffBenchmarkEntries({
          snapshot,
          current,
          priorStates,
          changeToken: revisionToken,
          resetDefinition: true
        });
        this.applyEntryUpdates(snapshot, stateDiff.updates, new Set(current.map((entry) => entry.entityKey)));
        this.insertMeasurements(snapshotId, snapshot.leaderboardId, current);
        this.acceptLeaderboardSnapshot(snapshot, snapshotId, definition);
        const event = createDomainEvent({
          type: "benchmark.definition_changed",
          sourceId: snapshot.sourceId,
          leaderboardId: snapshot.leaderboardId,
          occurredAt: snapshot.sourceUpdatedAt ?? snapshot.observedAt,
          detectedAt: snapshot.observedAt,
          immediate: true,
          payload: {
            sourceId: snapshot.sourceId,
            leaderboardId: snapshot.leaderboardId,
            reason: `definition changed from ${leaderboard.version} to ${snapshot.version}`
          },
          changeToken: revisionToken
        });
        return {
          baseline: false,
          changed: true,
          quarantined: false,
          events: this.insertEvents([event])
        };
      }

      const currentAccepted = leaderboard.current_snapshot_id
        ? this.one<SnapshotRow>("SELECT * FROM snapshots WHERE id = ?", leaderboard.current_snapshot_id)
        : undefined;
      if (currentAccepted?.content_hash === contentHash) {
        this.clearPendingAnomaly(snapshot.leaderboardId, snapshot.observedAt);
        const confirmation = diffBenchmarkEntries({
          snapshot,
          current,
          priorStates,
          changeToken: contentHash
        });
        this.applyEntryUpdates(
          snapshot,
          confirmation.updates,
          new Set(current.map((entry) => entry.entityKey))
        );
        return {
          baseline: false,
          changed: false,
          quarantined: false,
          events: this.insertEvents(confirmation.events)
        };
      }

      const anomaly = baseline
        ? { anomalous: false, reasons: [], rowDropRatio: 0, top50MovementRatio: 0 }
        : detectBenchmarkAnomaly(previousEntries, current);
      if (anomaly.anomalous) {
        if (leaderboard.pending_anomaly_count >= 1) {
          let snapshotId: string;
          if (
            leaderboard.pending_anomaly_hash === contentHash &&
            leaderboard.pending_anomaly_snapshot_id
          ) {
            snapshotId = leaderboard.pending_anomaly_snapshot_id;
            this.sqlite
              .prepare("UPDATE snapshots SET status = 'accepted' WHERE id = ?")
              .run(snapshotId);
          } else {
            snapshotId = this.insertSnapshot(
              snapshot,
              contentHash,
              "accepted",
              anomaly.reasons.join("; ")
            );
          }
          const stateDiff = diffBenchmarkEntries({
            snapshot,
            current,
            priorStates,
            changeToken: revisionToken,
            resetDefinition: true
          });
          this.applyEntryUpdates(
            snapshot,
            stateDiff.updates,
            new Set(current.map((entry) => entry.entityKey))
          );
          this.insertMeasurements(snapshotId, snapshot.leaderboardId, current);
          this.acceptLeaderboardSnapshot(snapshot, snapshotId, definition);
          const event = createDomainEvent({
            type: "benchmark.definition_changed",
            sourceId: snapshot.sourceId,
            leaderboardId: snapshot.leaderboardId,
            occurredAt: snapshot.sourceUpdatedAt ?? snapshot.observedAt,
            detectedAt: snapshot.observedAt,
            immediate: true,
            payload: {
              sourceId: snapshot.sourceId,
              leaderboardId: snapshot.leaderboardId,
              reason: `repeated anomalous snapshot: ${anomaly.reasons.join("; ")}`
            },
            changeToken: revisionToken
          });
          return {
            baseline: false,
            changed: true,
            quarantined: false,
            events: this.insertEvents([event])
          };
        }

        const snapshotId = this.insertSnapshot(
          snapshot,
          contentHash,
          "quarantined",
          anomaly.reasons.join("; ")
        );
        this.setPendingAnomaly(snapshot.leaderboardId, snapshotId, contentHash, 1, snapshot.observedAt);
        return { baseline: false, changed: true, quarantined: true, events: [] };
      }

      const snapshotId = this.insertSnapshot(snapshot, contentHash, "accepted");
      const stateDiff = diffBenchmarkEntries({
        snapshot,
        current,
        priorStates,
        changeToken: revisionToken,
        baseline
      });
      this.applyEntryUpdates(snapshot, stateDiff.updates, new Set(current.map((entry) => entry.entityKey)));
      this.insertMeasurements(snapshotId, snapshot.leaderboardId, current);
      this.acceptLeaderboardSnapshot(snapshot, snapshotId, definition);
      return {
        baseline,
        changed: true,
        quarantined: false,
        events: baseline ? [] : this.insertEvents(stateDiff.events)
      };
    });
  }

  private ensureLeaderboard(snapshot: BenchmarkSnapshot): LeaderboardRow {
    const existing = this.one<LeaderboardRow>("SELECT * FROM leaderboards WHERE id = ?", snapshot.leaderboardId);
    if (existing) return existing;
    const definition = snapshotDefinition(snapshot);
    this.sqlite
      .prepare(
        `INSERT INTO leaderboards
           (id, source_id, name, category, entity_type, source_url, version,
            score_precision, definition_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.leaderboardId,
        snapshot.sourceId,
        snapshot.leaderboardName,
        snapshot.category,
        snapshot.entityType,
        snapshot.sourceUrl,
        snapshot.version,
        snapshot.scorePrecision,
        definition,
        snapshot.observedAt
      );
    return this.one<LeaderboardRow>("SELECT * FROM leaderboards WHERE id = ?", snapshot.leaderboardId)!;
  }

  private insertSnapshot(
    snapshot: SourceSnapshot,
    contentHash: string,
    status: "accepted" | "quarantined",
    anomalyReason?: string
  ): string {
    const id = newId();
    const leaderboardId = snapshot.kind === "benchmark" ? snapshot.leaderboardId : null;
    const scopeKey = snapshot.kind === "benchmark" ? snapshot.leaderboardId : `announcement:${snapshot.sourceId}`;
    this.sqlite
      .prepare(
        `INSERT INTO snapshots
           (id, kind, scope_key, source_id, leaderboard_id, observed_at, source_updated_at,
            version, checkpoint_json, content_hash, status, anomaly_reason, row_count, changed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        id,
        snapshot.kind,
        scopeKey,
        snapshot.sourceId,
        leaderboardId,
        snapshot.observedAt,
        snapshot.kind === "benchmark" ? (snapshot.sourceUpdatedAt ?? null) : null,
        snapshot.kind === "benchmark" ? snapshot.version : null,
        JSON.stringify(snapshot.checkpoint),
        contentHash,
        status,
        anomalyReason ?? null,
        snapshot.kind === "benchmark" ? snapshot.entries.length : snapshot.items.length,
        snapshot.observedAt
      );
    return id;
  }

  private acceptLeaderboardSnapshot(
    snapshot: BenchmarkSnapshot,
    snapshotId: string,
    definition: string
  ): void {
    this.sqlite
      .prepare(
        `UPDATE leaderboards SET
           source_id = ?, name = ?, category = ?, entity_type = ?, source_url = ?,
           version = ?, score_precision = ?, definition_json = ?, current_snapshot_id = ?,
           pending_anomaly_snapshot_id = NULL, pending_anomaly_hash = NULL,
           pending_anomaly_count = 0, updated_at = ?
         WHERE id = ?`
      )
      .run(
        snapshot.sourceId,
        snapshot.leaderboardName,
        snapshot.category,
        snapshot.entityType,
        snapshot.sourceUrl,
        snapshot.version,
        snapshot.scorePrecision,
        definition,
        snapshotId,
        snapshot.observedAt,
        snapshot.leaderboardId
      );
  }

  private setPendingAnomaly(
    leaderboardId: LeaderboardId,
    snapshotId: string,
    contentHash: string,
    count: number,
    observedAt: string
  ): void {
    this.sqlite
      .prepare(
        `UPDATE leaderboards SET pending_anomaly_snapshot_id = ?, pending_anomaly_hash = ?,
          pending_anomaly_count = ?, updated_at = ? WHERE id = ?`
      )
      .run(snapshotId, contentHash, count, observedAt, leaderboardId);
  }

  private clearPendingAnomaly(leaderboardId: LeaderboardId, observedAt: string): void {
    this.sqlite
      .prepare(
        `UPDATE leaderboards SET pending_anomaly_snapshot_id = NULL, pending_anomaly_hash = NULL,
          pending_anomaly_count = 0, updated_at = ? WHERE id = ?`
      )
      .run(observedAt, leaderboardId);
  }

  private snapshotEntries(snapshotId: string): LeaderboardEntry[] {
    return this.all<Row>(
      `SELECT e.entity_key, e.name, e.organization, m.rank, m.score, m.score_display,
              m.verified, m.metadata_json
         FROM measurements m JOIN entities e ON e.id = m.entity_id
        WHERE m.snapshot_id = ?`,
      snapshotId
    ).map((row) => ({
      entityKey: String(row.entity_key),
      name: String(row.name),
      organization: row.organization ? String(row.organization) : undefined,
      rank: Number(row.rank),
      score: Number(row.score),
      scoreDisplay: String(row.score_display),
      verified: optionalBoolean(row.verified),
      metadata: row.metadata_json
        ? jsonParse<Record<string, unknown>>(row.metadata_json, {})
        : undefined
    }));
  }

  private entryStates(leaderboardId: LeaderboardId): StoredEntryState[] {
    return this.all<Row>("SELECT * FROM entities WHERE leaderboard_id = ?", leaderboardId).map(
      (row) => ({
        entityKey: String(row.entity_key),
        name: String(row.name),
        organization: row.organization ? String(row.organization) : undefined,
        rank: Number(row.last_rank),
        score: Number(row.last_score),
        scoreDisplay: String(row.last_score_display),
        verified: optionalBoolean(row.last_verified),
        metadata: row.metadata_json
          ? jsonParse<Record<string, unknown>>(row.metadata_json, {})
          : undefined,
        active: Number(row.active) !== 0,
        missingCount: Number(row.missing_count)
      })
    );
  }

  private applyEntryUpdates(
    snapshot: BenchmarkSnapshot,
    updates: readonly EntryStateUpdate[],
    seenKeys: ReadonlySet<string>
  ): void {
    const upsertSeen = this.sqlite.prepare(
      `INSERT INTO entities
         (id, leaderboard_id, entity_key, name, organization, entity_type, metadata_json,
          last_rank, last_score, last_score_display, last_verified, active, missing_count,
          first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(leaderboard_id, entity_key) DO UPDATE SET
         name = excluded.name, organization = excluded.organization,
         metadata_json = excluded.metadata_json, last_rank = excluded.last_rank,
         last_score = excluded.last_score, last_score_display = excluded.last_score_display,
         last_verified = excluded.last_verified, active = excluded.active,
         missing_count = excluded.missing_count, last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`
    );
    const updateMissing = this.sqlite.prepare(
      `UPDATE entities SET active = ?, missing_count = ?, updated_at = ?
        WHERE leaderboard_id = ? AND entity_key = ?`
    );
    for (const update of updates) {
      if (seenKeys.has(update.entry.entityKey)) {
        upsertSeen.run(
          newId(),
          snapshot.leaderboardId,
          update.entry.entityKey,
          update.entry.name,
          update.entry.organization ?? null,
          snapshot.entityType,
          update.entry.metadata ? JSON.stringify(update.entry.metadata) : null,
          update.entry.rank,
          update.entry.score,
          update.entry.scoreDisplay,
          update.entry.verified === undefined ? null : update.entry.verified ? 1 : 0,
          update.active ? 1 : 0,
          update.missingCount,
          snapshot.observedAt,
          snapshot.observedAt,
          snapshot.observedAt
        );
      } else {
        updateMissing.run(
          update.active ? 1 : 0,
          update.missingCount,
          snapshot.observedAt,
          snapshot.leaderboardId,
          update.entry.entityKey
        );
      }
    }
  }

  private insertMeasurements(
    snapshotId: string,
    leaderboardId: LeaderboardId,
    entries: readonly LeaderboardEntry[]
  ): void {
    const findEntity = this.sqlite.prepare(
      "SELECT id FROM entities WHERE leaderboard_id = ? AND entity_key = ?"
    );
    const insert = this.sqlite.prepare(
      `INSERT INTO measurements
         (snapshot_id, entity_id, rank, score, score_display, verified, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const entry of entries) {
      const entity = findEntity.get(leaderboardId, entry.entityKey) as { id: string } | undefined;
      if (!entity) throw new Error(`missing entity state for ${entry.entityKey}`);
      insert.run(
        snapshotId,
        entity.id,
        entry.rank,
        entry.score,
        entry.scoreDisplay,
        entry.verified === undefined ? null : entry.verified ? 1 : 0,
        entry.metadata ? JSON.stringify(entry.metadata) : null
      );
    }
  }

  private processAnnouncementSnapshot(snapshot: AnnouncementSnapshot): SnapshotResult {
    const contentHash = announcementContentHash(snapshot);
    return this.transaction(() => {
      const latest = this.one<SnapshotRow>(
        `SELECT * FROM snapshots WHERE scope_key = ? AND status = 'accepted'
          ORDER BY created_at DESC LIMIT 1`,
        `announcement:${snapshot.sourceId}`
      );
      if (latest?.content_hash === contentHash) {
        return { baseline: false, changed: false, quarantined: false, events: [] };
      }

      const baseline = !latest;
      this.insertSnapshot(snapshot, contentHash, "accepted");
      const generated: DomainEvent[] = [];
      for (const item of snapshot.items) {
        const itemHash = fingerprint(item);
        const existing = this.one<Row>(
          "SELECT * FROM announcements WHERE source_id = ? AND item_key = ?",
          snapshot.sourceId,
          item.itemKey
        );
        if (!existing) {
          this.insertAnnouncement(snapshot, item, itemHash);
          if (!baseline) generated.push(this.announcementEvent(snapshot, item, contentHash));
          continue;
        }

        const promoted = existing.confidence === "candidate" && item.confidence === "confirmed";
        this.updateAnnouncement(snapshot, item, itemHash);
        if (promoted) generated.push(this.announcementEvent(snapshot, item, contentHash));
      }
      return {
        baseline,
        changed: true,
        quarantined: false,
        events: baseline ? [] : this.insertEvents(generated)
      };
    });
  }

  private insertAnnouncement(
    snapshot: AnnouncementSnapshot,
    item: AnnouncementItem,
    contentHash: string
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO announcements
           (id, source_id, item_key, provider_name, title, url, published_at, summary,
            model_ids_json, stage, confidence, modality, content_hash, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newId(),
        snapshot.sourceId,
        item.itemKey,
        snapshot.providerName,
        item.title,
        item.url,
        item.publishedAt ?? null,
        item.summary?.slice(0, 1000) ?? null,
        JSON.stringify(item.modelIds),
        item.stage,
        item.confidence,
        item.modality,
        contentHash,
        snapshot.observedAt,
        snapshot.observedAt
      );
  }

  private updateAnnouncement(
    snapshot: AnnouncementSnapshot,
    item: AnnouncementItem,
    contentHash: string
  ): void {
    this.sqlite
      .prepare(
        `UPDATE announcements SET provider_name = ?, title = ?, url = ?, published_at = ?,
          summary = ?, model_ids_json = ?, stage = ?, confidence = ?, modality = ?,
          content_hash = ?, last_seen_at = ? WHERE source_id = ? AND item_key = ?`
      )
      .run(
        snapshot.providerName,
        item.title,
        item.url,
        item.publishedAt ?? null,
        item.summary?.slice(0, 1000) ?? null,
        JSON.stringify(item.modelIds),
        item.stage,
        item.confidence,
        item.modality,
        contentHash,
        snapshot.observedAt,
        snapshot.sourceId,
        item.itemKey
      );
  }

  private announcementEvent(
    snapshot: AnnouncementSnapshot,
    item: AnnouncementItem,
    changeToken: string
  ): DomainEvent {
    return createDomainEvent({
      type:
        item.confidence === "confirmed"
          ? "provider.model_announced"
          : "provider.announcement_candidate",
      sourceId: snapshot.sourceId,
      occurredAt: item.publishedAt ?? snapshot.observedAt,
      detectedAt: snapshot.observedAt,
      immediate: item.confidence === "confirmed",
      payload: {
        sourceId: snapshot.sourceId,
        title: item.title,
        url: item.url,
        stage: item.stage,
        metadata: {
          providerName: snapshot.providerName,
          modelIds: item.modelIds,
          modality: item.modality,
          summary: item.summary?.slice(0, 500)
        }
      },
      changeToken: `${changeToken}:${item.itemKey}:${item.confidence}`
    });
  }

  getGuildSettings(guildId: string): GuildSettings | undefined {
    const row = this.one<Row>("SELECT * FROM guild_settings WHERE guild_id = ?", guildId);
    if (!row) return undefined;
    return {
      guildId: String(row.guild_id),
      channelId: row.channel_id ? String(row.channel_id) : undefined,
      locale: String(row.locale),
      timeZone: String(row.time_zone)
    };
  }

  setGuildChannel(guildId: string, channelId: string, timeZone: string): GuildSettings {
    const now = new Date().toISOString();
    this.transaction(() => {
      const previous = this.one<Row>(
        "SELECT channel_id FROM guild_settings WHERE guild_id = ?",
        guildId
      );
      this.sqlite
        .prepare(
          `INSERT INTO guild_settings
             (guild_id, channel_id, locale, time_zone, created_at, updated_at)
           VALUES (?, ?, 'ja', ?, ?, ?)
           ON CONFLICT(guild_id) DO UPDATE SET
             channel_id = excluded.channel_id, time_zone = excluded.time_zone,
             updated_at = excluded.updated_at`
        )
        .run(guildId, channelId, timeZone, now, now);
      if (previous?.channel_id && String(previous.channel_id) !== channelId) {
        this.sqlite
          .prepare(
            `UPDATE deliveries SET channel_id = ?, status = 'pending', claimed_at = NULL,
              updated_at = ?
              WHERE guild_id = ? AND status IN ('pending', 'claimed')`
          )
          .run(channelId, now, guildId);
      }
      for (const target of WATCH_TARGETS) this.ensureSubscription(guildId, target, now);
    });
    return this.getGuildSettings(guildId)!;
  }

  disableGuildChannel(guildId: string, channelId: string): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE guild_settings SET channel_id = NULL, updated_at = ?
            WHERE guild_id = ? AND channel_id = ?`
        )
        .run(now, guildId, channelId);
      this.sqlite
        .prepare(
          `UPDATE deliveries SET status = 'failed', last_error = 'notification channel disabled',
            claimed_at = NULL, updated_at = ?
            WHERE guild_id = ? AND channel_id = ? AND status IN ('pending', 'claimed')`
        )
        .run(now, guildId, channelId);
    });
  }

  listWatchTargets(guildId: string): WatchTarget[] {
    const rows = this.all<Row>("SELECT target, enabled FROM subscriptions WHERE guild_id = ?", guildId);
    const explicit = new Map(rows.map((row) => [String(row.target), Number(row.enabled) !== 0]));
    return WATCH_TARGETS.map((target) => ({
      target,
      enabled: explicit.get(target) ?? defaultWatchEnabled(target)
    }));
  }

  setWatchTarget(guildId: string, target: string, enabled: boolean): void {
    if (!(WATCH_TARGETS as readonly string[]).includes(target)) {
      throw new RangeError(`unknown watch target: ${target}`);
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      if (!this.getGuildSettings(guildId)) {
        this.sqlite
          .prepare(
            `INSERT INTO guild_settings
               (guild_id, channel_id, locale, time_zone, created_at, updated_at)
             VALUES (?, NULL, 'ja', 'Asia/Tokyo', ?, ?)`
          )
          .run(guildId, now, now);
      }
      this.sqlite
        .prepare(
          `INSERT INTO subscriptions (id, guild_id, target, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, target) DO UPDATE SET
             enabled = excluded.enabled, updated_at = excluded.updated_at`
        )
        .run(newId(), guildId, target, enabled ? 1 : 0, now, now);
    });
  }

  isWatchTargetEnabled(guildId: string, target: string): boolean {
    if (!(WATCH_TARGETS as readonly string[]).includes(target)) return false;
    const row = this.one<Row>(
      "SELECT enabled FROM subscriptions WHERE guild_id = ? AND target = ?",
      guildId,
      target
    );
    return row ? Number(row.enabled) !== 0 : defaultWatchEnabled(target);
  }

  private ensureSubscription(guildId: string, target: string, now: string): string {
    const existing = this.one<Row>(
      "SELECT id FROM subscriptions WHERE guild_id = ? AND target = ?",
      guildId,
      target
    );
    if (existing) return String(existing.id);
    const id = newId();
    this.sqlite
      .prepare(
        `INSERT INTO subscriptions (id, guild_id, target, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, guildId, target, defaultWatchEnabled(target) ? 1 : 0, now, now);
    return id;
  }

  enqueueImmediateEvents(events: DomainEvent[], guildId: string): number {
    return this.transaction(() => {
      const settings = this.getGuildSettings(guildId);
      if (!settings?.channelId) return 0;
      let inserted = 0;
      for (const event of events) {
        if (!event.immediate) continue;
        const target = this.enabledTargetForEvent(guildId, event);
        if (!target) continue;
        const persisted = this.one<Row>("SELECT id FROM events WHERE fingerprint = ?", event.fingerprint);
        if (!persisted) this.insertEvent(event);
        const eventRow = this.one<Row>("SELECT id FROM events WHERE fingerprint = ?", event.fingerprint);
        if (!eventRow) continue;
        const subscriptionId = this.ensureSubscription(guildId, target, event.detectedAt);
        const eventId = String(eventRow.id);
        if (!this.markEventGuildDelivery(eventId, guildId, event.detectedAt)) continue;
        this.markEventDelivery(eventId, subscriptionId, event.detectedAt);
        const deliveryId = newId();
        inserted += changes(
          this.sqlite
            .prepare(
              `INSERT INTO deliveries
                 (id, event_id, subscription_id, guild_id, channel_id, kind, payload_json,
                  status, attempts, next_attempt_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'event', ?, 'pending', 0, ?, ?, ?)`
            )
            .run(
              deliveryId,
              eventId,
              subscriptionId,
              guildId,
              settings.channelId,
              JSON.stringify({ event }),
              event.detectedAt,
              event.detectedAt,
              event.detectedAt
            )
        );
      }
      return inserted;
    });
  }

  reconcileImmediateDeliveries(guildId: string): number {
    return this.transaction(() => {
      const settingsRow = this.one<Row>("SELECT * FROM guild_settings WHERE guild_id = ?", guildId);
      if (!settingsRow?.channel_id) return 0;
      const channelId = String(settingsRow.channel_id);
      // Events from before the latest channel setup are history, not missed
      // outbox writes. The reconciliation window starts when this destination
      // was configured (or re-enabled).
      const configuredAt = String(settingsRow.updated_at);
      const events = this.all<EventRow>(
        `SELECT * FROM events WHERE immediate = 1 AND detected_at >= ?
          ORDER BY detected_at ASC`,
        configuredAt
      ).map(eventFromRow);
      let inserted = 0;
      for (const event of events) {
        const target = this.enabledTargetForEvent(guildId, event);
        if (!target) continue;
        const subscriptionId = this.ensureSubscription(guildId, target, configuredAt);
        const subscription = this.one<Row>(
          "SELECT updated_at FROM subscriptions WHERE id = ?",
          subscriptionId
        );
        if (subscription?.updated_at && event.detectedAt < String(subscription.updated_at)) continue;
        if (!this.markEventGuildDelivery(event.id, guildId, event.detectedAt)) continue;
        this.markEventDelivery(event.id, subscriptionId, event.detectedAt);
        inserted += changes(
          this.sqlite
            .prepare(
              `INSERT INTO deliveries
                 (id, event_id, subscription_id, guild_id, channel_id, kind, payload_json,
                  status, attempts, next_attempt_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'event', ?, 'pending', 0, ?, ?, ?)`
            )
            .run(
              newId(),
              event.id,
              subscriptionId,
              guildId,
              channelId,
              JSON.stringify({ event }),
              event.detectedAt,
              event.detectedAt,
              event.detectedAt
            )
        );
      }
      return inserted;
    });
  }

  private markEventDelivery(eventId: string, subscriptionId: string, createdAt: string): boolean {
    return (
      changes(
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO event_delivery_marks (event_id, subscription_id, created_at)
             VALUES (?, ?, ?)`
          )
          .run(eventId, subscriptionId, createdAt)
      ) === 1
    );
  }

  private markEventGuildDelivery(eventId: string, guildId: string, createdAt: string): boolean {
    return (
      changes(
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO event_guild_delivery_marks (event_id, guild_id, created_at)
             VALUES (?, ?, ?)`
          )
          .run(eventId, guildId, createdAt)
      ) === 1
    );
  }

  private eventTargets(event: DomainEvent): string[] {
    if (event.leaderboardId) return [event.leaderboardId];
    if (event.type.startsWith("provider.")) return [`provider-${event.sourceId}`];
    if (event.sourceId === "lmarena") return ["lmarena-overall", "lmarena-coding"];
    if (event.sourceId === "swebench") return ["swebench-verified"];
    return [`provider-${event.sourceId}`];
  }

  private enabledTargetForEvent(guildId: string, event: DomainEvent): string | undefined {
    return this.eventTargets(event).find((target) => this.isWatchTargetEnabled(guildId, target));
  }

  enqueueTest(guildId: string, channelId: string): string {
    const now = new Date().toISOString();
    const id = newId();
    this.sqlite
      .prepare(
        `INSERT INTO deliveries
           (id, guild_id, channel_id, kind, payload_json, status, attempts,
            next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'test', ?, 'pending', 0, ?, ?, ?)`
      )
      .run(id, guildId, channelId, JSON.stringify({ message: "AI benchmark bot test" }), now, now, now);
    return id;
  }

  enqueueDigest(guildId: string, dateKey: string, now: string, force = false): number {
    return this.transaction(() => {
      const settings = this.getGuildSettings(guildId);
      if (!settings?.channelId) return 0;
      const normalDedupe = `${guildId}:${dateKey}`;
      if (!force && this.one<Row>("SELECT id FROM digest_runs WHERE dedupe_key = ?", normalDedupe)) {
        return 0;
      }

      const previous = force
        ? undefined
        : this.one<Row>(
            `SELECT generated_at FROM digest_runs
              WHERE guild_id = ? AND forced = 0 ORDER BY generated_at DESC LIMIT 1`,
            guildId
          );
      const fallbackSince = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
      const since = previous?.generated_at ? String(previous.generated_at) : fallbackSince;
      const settingsRow = this.one<Row>(
        "SELECT updated_at FROM guild_settings WHERE guild_id = ?",
        guildId
      );
      const configuredAt = String(settingsRow?.updated_at ?? now);
      const subscriptionRows = this.all<Row>(
        "SELECT target, enabled, updated_at FROM subscriptions WHERE guild_id = ?",
        guildId
      );
      const subscriptionsByTarget = new Map(
        subscriptionRows.map((row) => [String(row.target), row])
      );
      const candidates = this.all<EventRow>(
        `SELECT * FROM events WHERE immediate = 0 AND detected_at > ? AND detected_at <= ?
          ORDER BY detected_at ASC`,
        since,
        now
      )
        .map(eventFromRow)
        .filter((event) =>
          this.eventTargets(event).some((target) => {
            const subscription = subscriptionsByTarget.get(target);
            if (!subscription || Number(subscription.enabled) === 0) return false;
            const enabledAt = String(subscription.updated_at);
            const cutoff = enabledAt > configuredAt ? enabledAt : configuredAt;
            return event.detectedAt >= cutoff;
          })
        );

      const runId = newId();
      const dedupeKey = force ? `${normalDedupe}:force:${runId}` : normalDedupe;
      let deliveryId: string | null = null;
      if (candidates.length > 0) {
        deliveryId = newId();
        this.sqlite
          .prepare(
            `INSERT INTO deliveries
               (id, guild_id, channel_id, kind, payload_json, status, attempts,
                next_attempt_at, created_at, updated_at)
             VALUES (?, ?, ?, 'digest', ?, 'pending', 0, ?, ?, ?)`
          )
          .run(
            deliveryId,
            guildId,
            settings.channelId,
            JSON.stringify({
              dateKey,
              events: candidates.slice(0, 28),
              totalCount: candidates.length,
              // Attribution must cover omitted events as well as the bounded
              // event detail list kept inside the Discord payload.
              sourceIds: [...new Set(candidates.map((event) => event.sourceId))]
            }),
            now,
            now,
            now
          );
      }
      this.sqlite
        .prepare(
          `INSERT INTO digest_runs
             (id, guild_id, date_key, dedupe_key, forced, generated_at, event_count, delivery_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(runId, guildId, dateKey, dedupeKey, force ? 1 : 0, now, candidates.length, deliveryId);
      return deliveryId ? 1 : 0;
    });
  }

  claimPendingDeliveries(now: string, limit: number): Delivery[] {
    const bounded = validLimit(limit, 100);
    // Reclaim quickly after a process crash so Discord's finite recent-nonce
    // deduplication window is still likely to cover a POST that already won.
    const stale = new Date(new Date(now).getTime() - 60 * 1000).toISOString();
    return this.transaction(() => {
      const rows = this.all<Row>(
        `SELECT * FROM deliveries
          WHERE (status = 'pending' AND next_attempt_at <= ?)
             OR (status = 'claimed' AND claimed_at <= ?)
          ORDER BY next_attempt_at ASC, created_at ASC LIMIT ?`,
        now,
        stale,
        bounded
      );
      const claimed: Delivery[] = [];
      for (const row of rows) {
        const updated = this.sqlite
          .prepare(
            `UPDATE deliveries SET status = 'claimed', claimed_at = ?, attempts = attempts + 1,
              updated_at = ? WHERE id = ? AND
              ((status = 'pending' AND next_attempt_at <= ?) OR
               (status = 'claimed' AND claimed_at <= ?))`
          )
          .run(now, now, String(row.id), now, stale);
        if (changes(updated) !== 1) continue;
        claimed.push({
          id: String(row.id),
          eventId: row.event_id ? String(row.event_id) : undefined,
          guildId: String(row.guild_id),
          channelId: String(row.channel_id),
          kind: row.kind as Delivery["kind"],
          payload: jsonParse<Record<string, unknown>>(row.payload_json, {}),
          attempts: Number(row.attempts) + 1,
          nextAttemptAt: String(row.next_attempt_at)
        });
      }
      return claimed;
    });
  }

  markDeliverySent(deliveryId: string, discordMessageId: string, sentAt: string): void {
    this.sqlite
      .prepare(
        `UPDATE deliveries SET status = 'sent', discord_message_id = ?, sent_at = ?,
          claimed_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`
      )
      .run(discordMessageId, sentAt, sentAt, deliveryId);
  }

  markDeliveryRetry(deliveryId: string, errorMessage: string, nextAttemptAt: string): void {
    this.sqlite
      .prepare(
        `UPDATE deliveries SET status = 'pending', last_error = ?, next_attempt_at = ?,
          claimed_at = NULL, updated_at = ? WHERE id = ?`
      )
      .run(errorMessage.slice(0, 2000), nextAttemptAt, new Date().toISOString(), deliveryId);
  }

  markDeliveryFailed(deliveryId: string, errorMessage: string): void {
    this.sqlite
      .prepare(
        `UPDATE deliveries SET status = 'failed', last_error = ?, claimed_at = NULL,
          updated_at = ? WHERE id = ?`
      )
      .run(errorMessage.slice(0, 2000), new Date().toISOString(), deliveryId);
  }

  listRecentEvents(since: string, limit: number): DomainEvent[] {
    return this.all<EventRow>(
      "SELECT * FROM events WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT ?",
      since,
      validLimit(limit)
    ).map(eventFromRow);
  }

  getLeaderboard(leaderboardId: LeaderboardId, limit: number): LeaderboardEntry[] {
    const leaderboard = this.one<LeaderboardRow>("SELECT * FROM leaderboards WHERE id = ?", leaderboardId);
    if (!leaderboard?.current_snapshot_id) return [];
    return this.all<Row>(
      `SELECT e.entity_key, e.name, e.organization, m.rank, m.score, m.score_display,
              m.verified, m.metadata_json
         FROM measurements m JOIN entities e ON e.id = m.entity_id
        WHERE m.snapshot_id = ? ORDER BY m.rank ASC, e.name ASC LIMIT ?`,
      leaderboard.current_snapshot_id,
      validLimit(limit)
    ).map((row) => ({
      entityKey: String(row.entity_key),
      name: String(row.name),
      organization: row.organization ? String(row.organization) : undefined,
      rank: Number(row.rank),
      score: Number(row.score),
      scoreDisplay: String(row.score_display),
      verified: optionalBoolean(row.verified),
      metadata: row.metadata_json
        ? jsonParse<Record<string, unknown>>(row.metadata_json, {})
        : undefined
    }));
  }

  prune(now: string): { snapshots: number; deliveries: number } {
    const nowDate = new Date(now);
    if (Number.isNaN(nowDate.getTime())) throw new TypeError("now must be an ISO timestamp");
    const yearCutoff = new Date(nowDate.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const logCutoff = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    return this.transaction(() => {
      const deliveryCount = changes(
        this.sqlite
          .prepare(
            "DELETE FROM deliveries WHERE created_at < ? AND status IN ('sent', 'failed')"
          )
          .run(logCutoff)
      );
      this.sqlite.prepare("DELETE FROM digest_runs WHERE generated_at < ?").run(logCutoff);
      this.sqlite.prepare("DELETE FROM source_poll_logs WHERE attempted_at < ?").run(logCutoff);
      this.sqlite.prepare("DELETE FROM events WHERE created_at < ?").run(yearCutoff);
      const snapshotCount = changes(
        this.sqlite
          .prepare(
            `DELETE FROM snapshots WHERE created_at < ?
              AND id NOT IN (
                SELECT current_snapshot_id FROM leaderboards WHERE current_snapshot_id IS NOT NULL
              )
              AND id NOT IN (
                SELECT pending_anomaly_snapshot_id FROM leaderboards
                 WHERE pending_anomaly_snapshot_id IS NOT NULL
              )
              AND id NOT IN (
                SELECT candidate.id FROM snapshots candidate
                 WHERE candidate.kind = 'announcements' AND candidate.status = 'accepted'
                   AND candidate.created_at = (
                     SELECT MAX(latest.created_at) FROM snapshots latest
                      WHERE latest.scope_key = candidate.scope_key
                        AND latest.status = 'accepted'
                   )
              )`
          )
          .run(yearCutoff)
      );
      return { snapshots: snapshotCount, deliveries: deliveryCount };
    });
  }
}

export function createStore(databasePath = ":memory:"): BotStore {
  return new SqliteBotStore(databasePath);
}

export function migrateDatabase(databasePath: string): void {
  if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    applyMigrations(database);
  } finally {
    database.close();
  }
}

export async function backupDatabase(databasePath: string, destinationPath: string): Promise<void> {
  mkdirSync(dirname(resolve(destinationPath)), { recursive: true });
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backup(database, destinationPath);
  } finally {
    database.close();
  }
}
