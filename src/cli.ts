import { readdir, mkdir, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { loadConfig, requireDiscordConfig } from "./core/config.js";
import { createLogger, errorFields } from "./core/logger.js";
import {
  isSupportedNodeVersion,
  MINIMUM_NODE_VERSION,
  requireSupportedNodeVersion
} from "./core/runtime.js";
import { localDateKey } from "./core/time.js";
import { backupDatabase, createStore } from "./db/index.js";
import { registerGuildCommands } from "./discord/index.js";
import { createSourceAdapters } from "./sources/index.js";
import {
  REQUIRED_STAGED_CONTRACT_DAYS,
  STAGED_CONTRACT_VERSION
} from "./sources/staged.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  const nodeOk = isSupportedNodeVersion(process.versions.node);
  // Keep doctor runnable on an unsupported Node.js so it can explain the
  // failed prerequisite. Every mutating or networked command fails early.
  if (command !== "doctor") requireSupportedNodeVersion();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  switch (command) {
    case "migrate": {
      const store = createStore(config.databasePath);
      store.close();
      console.log(JSON.stringify({ ok: true, databasePath: config.databasePath }));
      return;
    }
    case "backup": {
      await mkdir(config.backupDir, { recursive: true });
      const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      const destination = join(config.backupDir, `bot-${stamp}.sqlite`);
      await backupDatabase(config.databasePath, destination);
      await retainNewestBackups(config.backupDir, 7);
      console.log(JSON.stringify({ ok: true, destination }));
      return;
    }
    case "register-commands": {
      requireDiscordConfig(config);
      await registerGuildCommands(config, logger);
      return;
    }
    case "check-sources": {
      const adapters = createSourceAdapters({
        enableMeta: config.enableMeta,
        enableQwen: config.enableQwen
      });
      let failures = 0;
      for (const adapter of adapters) {
        try {
          const snapshots = await adapter.poll({
            fetch: globalThis.fetch,
            now: new Date(),
            ...(config.githubToken ? { githubToken: config.githubToken } : {}),
            ...(config.huggingFaceToken ? { huggingFaceToken: config.huggingFaceToken } : {})
          });
          console.log(
            JSON.stringify({
              ok: true,
              sourceId: adapter.id,
              snapshots: snapshots.map((snapshot) => ({
                kind: snapshot.kind,
                target:
                  snapshot.kind === "benchmark"
                    ? snapshot.leaderboardId
                    : `provider-${snapshot.sourceId}`,
                count: snapshot.kind === "benchmark" ? snapshot.entries.length : snapshot.items.length,
                revision: snapshot.checkpoint.revision
              }))
            })
          );
        } catch (error) {
          failures += 1;
          logger.error("source contract check failed", { sourceId: adapter.id, ...errorFields(error) });
        }
      }
      if (failures > 0) process.exitCode = 1;
      return;
    }
    case "check-staged-contracts": {
      const store = createStore(config.databasePath);
      const now = new Date();
      const checkedAt = now.toISOString();
      const dateKey = localDateKey(now, config.timeZone);
      let failures = 0;
      try {
        const adapters = createSourceAdapters({ enableMeta: true, enableQwen: true });
        for (const adapter of adapters) {
          if (adapter.id !== "meta" && adapter.id !== "qwen") continue;
          try {
            const snapshots = await adapter.poll({ fetch: globalThis.fetch, now });
            if (snapshots.length !== 1 || snapshots[0]?.kind !== "announcements") {
              throw new Error(`${adapter.displayName} returned an invalid contract snapshot`);
            }
            store.recordAdapterContractCheck(
              adapter.id,
              dateKey,
              checkedAt,
              true,
              STAGED_CONTRACT_VERSION
            );
            const streak = store.getAdapterContractStreak(
              adapter.id,
              dateKey,
              STAGED_CONTRACT_VERSION
            );
            console.log(
              JSON.stringify({
                ok: true,
                sourceId: adapter.id,
                dateKey,
                itemCount: snapshots[0].items.length,
                streak,
                requiredDays: REQUIRED_STAGED_CONTRACT_DAYS,
                ready: streak >= REQUIRED_STAGED_CONTRACT_DAYS
              })
            );
          } catch (error) {
            failures += 1;
            const errorMessage = error instanceof Error ? error.message : String(error);
            store.recordAdapterContractCheck(
              adapter.id,
              dateKey,
              checkedAt,
              false,
              STAGED_CONTRACT_VERSION,
              errorMessage
            );
            logger.error("staged adapter contract check failed", {
              sourceId: adapter.id,
              ...errorFields(error)
            });
          }
        }
      } finally {
        store.close();
      }
      if (failures > 0) process.exitCode = 1;
      return;
    }
    case "doctor": {
      const store = createStore(config.databasePath);
      const dateKey = localDateKey(new Date(), config.timeZone);
      const metaStreak = store.getAdapterContractStreak(
        "meta",
        dateKey,
        STAGED_CONTRACT_VERSION
      );
      const qwenStreak = store.getAdapterContractStreak(
        "qwen",
        dateKey,
        STAGED_CONTRACT_VERSION
      );
      const metaReady = metaStreak >= REQUIRED_STAGED_CONTRACT_DAYS;
      const qwenReady = qwenStreak >= REQUIRED_STAGED_CONTRACT_DAYS;
      const sources = createSourceAdapters({
        enableMeta: config.enableMeta && metaReady,
        enableQwen: config.enableQwen && qwenReady
      }).map((adapter) => adapter.id);
      store.close();
      const contractsOk = (!config.enableMeta || metaReady) && (!config.enableQwen || qwenReady);
      const discordConfigured = Boolean(
        config.discordToken && config.discordClientId && config.discordGuildId
      );
      console.log(
        JSON.stringify({
          ok: nodeOk && contractsOk && discordConfigured,
          node: process.versions.node,
          nodeSupported: nodeOk,
          requiredNode: `>=${MINIMUM_NODE_VERSION}`,
          databasePath: config.databasePath,
          sources,
          stagedContracts: {
            meta: { requested: config.enableMeta, streak: metaStreak, ready: metaReady },
            qwen: { requested: config.enableQwen, streak: qwenStreak, ready: qwenReady },
            requiredDays: REQUIRED_STAGED_CONTRACT_DAYS,
            version: STAGED_CONTRACT_VERSION
          },
          discordConfigured
        })
      );
      if (!nodeOk || !contractsOk || !discordConfigured) process.exitCode = 1;
      return;
    }
    default:
      console.log(
        [
          "Usage: node dist/cli.js <command>",
          "",
          "Commands:",
          "  migrate            Create or upgrade the SQLite schema",
          "  backup             Create a consistent SQLite backup and retain 7 copies",
          "  register-commands  Register the guild-scoped /benchmark command",
          "  check-sources      Fetch and validate every enabled upstream source",
          "  check-staged-contracts  Record one daily Meta/Qwen contract smoke test",
          "  doctor             Validate runtime, database, sources and configuration"
        ].join("\n")
      );
  }
}

async function retainNewestBackups(directory: string, retain: number): Promise<void> {
  const root = resolve(directory);
  const files = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^bot-.*\.sqlite$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const file of files.slice(retain)) {
    const target = resolve(root, file);
    if (!target.startsWith(`${root}${sep}`) || basename(target) !== file) {
      throw new Error(`Refusing to remove backup outside ${root}`);
    }
    await unlink(target);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, ...errorFields(error) }));
  process.exitCode = 1;
});
