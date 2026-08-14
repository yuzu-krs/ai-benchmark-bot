import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT,
  locale TEXT NOT NULL DEFAULT 'ja',
  time_zone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, target)
);

CREATE TABLE source_state (
  source_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_attempt_at TEXT,
  last_success_at TEXT,
  next_poll_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  health TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy', 'degraded')),
  checkpoint_json TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE source_poll_logs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('attempted', 'success', 'failure')),
  error_message TEXT
);
CREATE INDEX source_poll_logs_source_attempt_idx ON source_poll_logs(source_id, attempted_at);

CREATE TABLE leaderboards (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('model', 'submission')),
  source_url TEXT NOT NULL,
  version TEXT NOT NULL,
  score_precision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  current_snapshot_id TEXT,
  pending_anomaly_snapshot_id TEXT,
  pending_anomaly_hash TEXT,
  pending_anomaly_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  leaderboard_id TEXT NOT NULL REFERENCES leaderboards(id) ON DELETE CASCADE,
  entity_key TEXT NOT NULL,
  name TEXT NOT NULL,
  organization TEXT,
  entity_type TEXT NOT NULL,
  metadata_json TEXT,
  last_rank INTEGER NOT NULL,
  last_score REAL NOT NULL,
  last_score_display TEXT NOT NULL,
  last_verified INTEGER CHECK (last_verified IN (0, 1) OR last_verified IS NULL),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  missing_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (leaderboard_id, entity_key)
);

CREATE TABLE aliases (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('benchmark', 'announcements')),
  scope_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  leaderboard_id TEXT REFERENCES leaderboards(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  source_updated_at TEXT,
  version TEXT,
  checkpoint_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'quarantined')),
  anomaly_reason TEXT,
  row_count INTEGER NOT NULL,
  changed INTEGER NOT NULL DEFAULT 1 CHECK (changed IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX snapshots_scope_created_idx ON snapshots(scope_key, created_at);
CREATE INDEX snapshots_created_idx ON snapshots(created_at);

CREATE TABLE measurements (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  score_display TEXT NOT NULL,
  verified INTEGER CHECK (verified IN (0, 1) OR verified IS NULL),
  metadata_json TEXT,
  PRIMARY KEY (snapshot_id, entity_id)
);
CREATE INDEX measurements_snapshot_rank_idx ON measurements(snapshot_id, rank);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT,
  summary TEXT,
  model_ids_json TEXT NOT NULL,
  stage TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'candidate')),
  modality TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (source_id, item_key)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  leaderboard_id TEXT,
  occurred_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  immediate INTEGER NOT NULL CHECK (immediate IN (0, 1)),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_detected_idx ON events(detected_at);
CREATE INDEX events_immediate_detected_idx ON events(immediate, detected_at);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'digest', 'test')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  claimed_at TEXT,
  discord_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (event_id, subscription_id)
);
CREATE INDEX deliveries_pending_idx ON deliveries(status, next_attempt_at);

CREATE TABLE digest_runs (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  forced INTEGER NOT NULL DEFAULT 0 CHECK (forced IN (0, 1)),
  generated_at TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL
);
CREATE INDEX digest_runs_guild_generated_idx ON digest_runs(guild_id, generated_at);
`
  },
  {
    version: 2,
    name: "durable_delivery_marks_and_phase_two_watch_defaults",
    sql: `
CREATE TABLE event_delivery_marks (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, subscription_id)
);

INSERT OR IGNORE INTO event_delivery_marks (event_id, subscription_id, created_at)
SELECT event_id, subscription_id, created_at
  FROM deliveries
 WHERE event_id IS NOT NULL AND subscription_id IS NOT NULL;

UPDATE subscriptions
   SET enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE target IN ('provider-meta', 'provider-qwen');
`
  },
  {
    version: 3,
    name: "adapter_contract_checks",
    sql: `
CREATE TABLE adapter_contract_checks (
  source_id TEXT NOT NULL CHECK (source_id IN ('meta', 'qwen')),
  date_key TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  contract_version TEXT NOT NULL,
  error_message TEXT,
  PRIMARY KEY (source_id, date_key)
);
`
  },
  {
    version: 4,
    name: "guild_level_event_delivery_marks",
    sql: `
CREATE TABLE event_guild_delivery_marks (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, guild_id)
);

INSERT OR IGNORE INTO event_guild_delivery_marks (event_id, guild_id, created_at)
SELECT marks.event_id, subscriptions.guild_id, MIN(marks.created_at)
  FROM event_delivery_marks marks
  JOIN subscriptions ON subscriptions.id = marks.subscription_id
 GROUP BY marks.event_id, subscriptions.guild_id;

INSERT OR IGNORE INTO event_guild_delivery_marks (event_id, guild_id, created_at)
SELECT event_id, guild_id, MIN(created_at)
  FROM deliveries
 WHERE event_id IS NOT NULL
 GROUP BY event_id, guild_id;
`
  }
];

export function applyMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const appliedRows = database.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  const insert = database.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      insert.run(migration.version, migration.name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
