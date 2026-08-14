import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "../../src/db/migrations.js";

describe("database migrations", () => {
  it("adds opt-in Z.ai and Moonshot watches off without overriding a choice", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      const recordMigration = database.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      );
      for (const migration of MIGRATIONS.filter((entry) => entry.version <= 4)) {
        database.exec(migration.sql);
        recordMigration.run(migration.version, migration.name, "2026-08-14T00:00:00.000Z");
      }

      const insertGuild = database.prepare(
        `INSERT INTO guild_settings
           (guild_id, channel_id, locale, time_zone, created_at, updated_at)
         VALUES (?, 'channel', 'ja', 'Asia/Tokyo', ?, ?)`
      );
      insertGuild.run("guild-defaults", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
      insertGuild.run("guild-explicit", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
      database
        .prepare(
          `INSERT INTO subscriptions
             (id, guild_id, target, enabled, created_at, updated_at)
           VALUES ('existing-zai', 'guild-explicit', 'provider-zai', 1, ?, ?)`
        )
        .run("2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z");

      applyMigrations(database);

      const rows = database
        .prepare(
          `SELECT guild_id, target, enabled FROM subscriptions
            WHERE target IN ('provider-zai', 'provider-moonshot')
            ORDER BY guild_id, target`
        )
        .all() as Array<{ guild_id: string; target: string; enabled: number }>;
      expect(rows).toEqual([
        { guild_id: "guild-defaults", target: "provider-moonshot", enabled: 0 },
        { guild_id: "guild-defaults", target: "provider-zai", enabled: 0 },
        { guild_id: "guild-explicit", target: "provider-moonshot", enabled: 0 },
        { guild_id: "guild-explicit", target: "provider-zai", enabled: 1 }
      ]);
      expect(
        database.prepare("SELECT name FROM schema_migrations WHERE version = 5").get()
      ).toEqual({ name: "zai_and_moonshot_opt_in_watch_defaults" });
    } finally {
      database.close();
    }
  });
});
