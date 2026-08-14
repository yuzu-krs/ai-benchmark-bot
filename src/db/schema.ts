import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

export const guildSettings = sqliteTable("guild_settings", {
  guildId: text("guild_id").primaryKey(),
  channelId: text("channel_id"),
  locale: text("locale").notNull().default("ja"),
  timeZone: text("time_zone").notNull().default("Asia/Tokyo"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id")
      .notNull()
      .references(() => guildSettings.guildId, { onDelete: "cascade" }),
    target: text("target").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("subscriptions_guild_target_uq").on(table.guildId, table.target)]
);

export const sourceState = sqliteTable("source_state", {
  sourceId: text("source_id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastAttemptAt: text("last_attempt_at"),
  lastSuccessAt: text("last_success_at"),
  nextPollAt: text("next_poll_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  health: text("health").notNull().default("healthy"),
  checkpointJson: text("checkpoint_json"),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull()
});

export const sourcePollLogs = sqliteTable(
  "source_poll_logs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    attemptedAt: text("attempted_at").notNull(),
    completedAt: text("completed_at"),
    status: text("status").notNull(),
    errorMessage: text("error_message")
  },
  (table) => [index("source_poll_logs_source_attempt_idx").on(table.sourceId, table.attemptedAt)]
);

export const adapterContractChecks = sqliteTable(
  "adapter_contract_checks",
  {
    sourceId: text("source_id").notNull(),
    dateKey: text("date_key").notNull(),
    checkedAt: text("checked_at").notNull(),
    success: integer("success", { mode: "boolean" }).notNull(),
    contractVersion: text("contract_version").notNull(),
    errorMessage: text("error_message")
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.dateKey] })]
);

export const leaderboards = sqliteTable("leaderboards", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  entityType: text("entity_type").notNull(),
  sourceUrl: text("source_url").notNull(),
  version: text("version").notNull(),
  scorePrecision: integer("score_precision").notNull(),
  definitionJson: text("definition_json").notNull(),
  currentSnapshotId: text("current_snapshot_id"),
  pendingAnomalySnapshotId: text("pending_anomaly_snapshot_id"),
  pendingAnomalyHash: text("pending_anomaly_hash"),
  pendingAnomalyCount: integer("pending_anomaly_count").notNull().default(0),
  updatedAt: text("updated_at").notNull()
});

export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    leaderboardId: text("leaderboard_id")
      .notNull()
      .references(() => leaderboards.id, { onDelete: "cascade" }),
    entityKey: text("entity_key").notNull(),
    name: text("name").notNull(),
    organization: text("organization"),
    entityType: text("entity_type").notNull(),
    metadataJson: text("metadata_json"),
    lastRank: integer("last_rank").notNull(),
    lastScore: real("last_score").notNull(),
    lastScoreDisplay: text("last_score_display").notNull(),
    lastVerified: integer("last_verified", { mode: "boolean" }),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    missingCount: integer("missing_count").notNull().default(0),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("entities_leaderboard_key_uq").on(table.leaderboardId, table.entityKey)]
);

export const aliases = sqliteTable(
  "aliases",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    kind: text("kind").notNull().default("manual"),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("aliases_alias_uq").on(table.alias)]
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    scopeKey: text("scope_key").notNull(),
    sourceId: text("source_id").notNull(),
    leaderboardId: text("leaderboard_id").references(() => leaderboards.id, {
      onDelete: "cascade"
    }),
    observedAt: text("observed_at").notNull(),
    sourceUpdatedAt: text("source_updated_at"),
    version: text("version"),
    checkpointJson: text("checkpoint_json").notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull(),
    anomalyReason: text("anomaly_reason"),
    rowCount: integer("row_count").notNull(),
    changed: integer("changed", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("snapshots_scope_created_idx").on(table.scopeKey, table.createdAt),
    index("snapshots_created_idx").on(table.createdAt)
  ]
);

export const measurements = sqliteTable(
  "measurements",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    score: real("score").notNull(),
    scoreDisplay: text("score_display").notNull(),
    verified: integer("verified", { mode: "boolean" }),
    metadataJson: text("metadata_json")
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.entityId] }),
    index("measurements_snapshot_rank_idx").on(table.snapshotId, table.rank)
  ]
);

export const announcements = sqliteTable(
  "announcements",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    itemKey: text("item_key").notNull(),
    providerName: text("provider_name").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    publishedAt: text("published_at"),
    summary: text("summary"),
    modelIdsJson: text("model_ids_json").notNull(),
    stage: text("stage").notNull(),
    confidence: text("confidence").notNull(),
    modality: text("modality").notNull(),
    contentHash: text("content_hash").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull()
  },
  (table) => [uniqueIndex("announcements_source_item_uq").on(table.sourceId, table.itemKey)]
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    fingerprint: text("fingerprint").notNull(),
    type: text("type").notNull(),
    sourceId: text("source_id").notNull(),
    leaderboardId: text("leaderboard_id"),
    occurredAt: text("occurred_at").notNull(),
    detectedAt: text("detected_at").notNull(),
    immediate: integer("immediate", { mode: "boolean" }).notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("events_fingerprint_uq").on(table.fingerprint),
    index("events_detected_idx").on(table.detectedAt),
    index("events_immediate_detected_idx").on(table.immediate, table.detectedAt)
  ]
);

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").references(() => events.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null"
    }),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    claimedAt: text("claimed_at"),
    discordMessageId: text("discord_message_id"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    sentAt: text("sent_at")
  },
  (table) => [
    uniqueIndex("deliveries_event_subscription_uq").on(table.eventId, table.subscriptionId),
    index("deliveries_pending_idx").on(table.status, table.nextAttemptAt)
  ]
);

export const eventDeliveryMarks = sqliteTable(
  "event_delivery_marks",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.eventId, table.subscriptionId] })]
);

export const eventGuildDeliveryMarks = sqliteTable(
  "event_guild_delivery_marks",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    guildId: text("guild_id").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.eventId, table.guildId] })]
);

export const digestRuns = sqliteTable(
  "digest_runs",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    dateKey: text("date_key").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    forced: integer("forced", { mode: "boolean" }).notNull().default(false),
    generatedAt: text("generated_at").notNull(),
    eventCount: integer("event_count").notNull(),
    deliveryId: text("delivery_id").references(() => deliveries.id, { onDelete: "set null" })
  },
  (table) => [
    uniqueIndex("digest_runs_dedupe_uq").on(table.dedupeKey),
    index("digest_runs_guild_generated_idx").on(table.guildId, table.generatedAt)
  ]
);
