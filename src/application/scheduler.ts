import type { AppConfig } from "../core/config.js";
import { errorFields, type Logger } from "../core/logger.js";
import { addMinutes, isoNow, localDateKey, localHourMinute } from "../core/time.js";
import type { DomainEvent, SourceAdapter, SourceId, SourceSnapshot } from "../domain/models.js";
import type { BotStore } from "./ports.js";

const TICK_INTERVAL_MS = 60_000;

export interface SchedulerOptions {
  adapters: SourceAdapter[];
  config: AppConfig;
  store: BotStore;
  guildId: string;
  logger: Logger;
  pumpDeliveries: () => Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export class AppScheduler {
  readonly #adapters: SourceAdapter[];
  readonly #config: AppConfig;
  readonly #store: BotStore;
  readonly #guildId: string;
  readonly #logger: Logger;
  readonly #pumpDeliveries: () => Promise<void>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #stopController = new AbortController();
  readonly #idleWaiters: Array<() => void> = [];
  #deliveryPumpChain: Promise<void> = Promise.resolve();
  #timer?: NodeJS.Timeout;
  #running = false;
  #lastRetentionDateKey?: string;

  constructor(options: SchedulerOptions) {
    this.#adapters = options.adapters;
    this.#config = options.config;
    this.#store = options.store;
    this.#guildId = options.guildId;
    this.#logger = options.logger;
    this.#pumpDeliveries = options.pumpDeliveries;
    const baseFetch = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => {
      const signals = [
        this.#stopController.signal,
        init?.signal ?? undefined,
        input instanceof Request ? input.signal : undefined
      ].filter((signal): signal is AbortSignal => signal !== undefined);
      return baseFetch(input, { ...init, signal: AbortSignal.any(signals) });
    };
    this.#now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#stopController.abort(new Error("scheduler stopped"));
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    if (!this.#running) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  async tick(): Promise<void> {
    if (this.#running) {
      this.#logger.warn("scheduler tick skipped because the previous tick is still running");
      return;
    }
    this.#running = true;
    const now = this.#now();
    try {
      const dueAdapters = this.#adapters.filter(
        (adapter) => !this.#stopController.signal.aborted && this.#isDue(adapter.id, now)
      );
      const polls = await Promise.allSettled(
        dueAdapters.map(async (adapter) => {
          await this.#pollAdapter(adapter, now);
          // Do not make a fast provider notification wait for a slower, unrelated
          // leaderboard poll. The chain keeps Discord REST pumps sequential.
          if (!this.#stopController.signal.aborted) await this.#queueDeliveryPump();
        })
      );
      for (const [index, result] of polls.entries()) {
        if (result.status === "rejected") {
          this.#logger.error("source poll task failed unexpectedly", {
            sourceId: dueAdapters[index]?.id,
            ...errorFields(result.reason)
          });
        }
      }
      if (this.#stopController.signal.aborted) return;
      this.#enqueueScheduledDigest(now);
      const recovered = this.#store.reconcileImmediateDeliveries(this.#guildId);
      if (recovered > 0) {
        this.#logger.info("missing outbox deliveries reconciled", { deliveryCount: recovered });
      }
      await this.#queueDeliveryPump();
      this.#runRetention(now);
    } catch (error) {
      this.#logger.error("scheduler tick failed", errorFields(error));
    } finally {
      this.#running = false;
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }
  }

  async pollAll(): Promise<void> {
    const now = this.#now();
    await Promise.all(this.#adapters.map((adapter) => this.#pollAdapter(adapter, now)));
    this.#store.reconcileImmediateDeliveries(this.#guildId);
    await this.#queueDeliveryPump();
  }

  #queueDeliveryPump(): Promise<void> {
    const next = this.#deliveryPumpChain
      .catch(() => undefined)
      .then(() => this.#pumpDeliveries());
    this.#deliveryPumpChain = next;
    return next;
  }

  #isDue(sourceId: SourceId, now: Date): boolean {
    const status = this.#store.getSourceStatus(sourceId);
    return !status?.nextPollAt || Date.parse(status.nextPollAt) <= now.getTime();
  }

  async #pollAdapter(adapter: SourceAdapter, now: Date): Promise<void> {
    const attemptedAt = isoNow(now);
    const previous = this.#store.getSourceStatus(adapter.id);
    this.#store.markSourceAttempt(adapter.id, attemptedAt);
    this.#logger.info("source poll started", { sourceId: adapter.id });

    try {
      const snapshots = await adapter.poll({
        checkpoint: previous?.checkpoint,
        fetch: this.#fetch,
        now,
        ...(this.#config.githubToken ? { githubToken: this.#config.githubToken } : {}),
        ...(this.#config.huggingFaceToken
          ? { huggingFaceToken: this.#config.huggingFaceToken }
          : {})
      });

      const events: DomainEvent[] = [];
      let quarantined = false;
      for (const snapshot of snapshots) {
        const result = this.#store.processSnapshot(snapshot);
        events.push(...result.events);
        quarantined ||= result.quarantined;
        this.#logger.info("source snapshot processed", {
          sourceId: adapter.id,
          kind: snapshot.kind,
          target: snapshotTarget(snapshot),
          baseline: result.baseline,
          changed: result.changed,
          quarantined: result.quarantined,
          eventCount: result.events.length
        });
      }
      if (snapshots.length === 0) {
        events.push(...this.#store.confirmUnchangedSource(adapter.id, attemptedAt));
      }

      // Do not advance conditional validators for an isolated snapshot. Keeping
      // the last accepted checkpoint forces a full response on the next poll,
      // which is the second observation required before redefining a board.
      const checkpoint = quarantined
        ? (previous?.checkpoint ?? {})
        : (snapshots[0]?.checkpoint ?? previous?.checkpoint ?? {});
      events.push(
        ...this.#store.markSourceSuccess(
          adapter.id,
          attemptedAt,
          isoNow(addMinutes(now, adapter.intervalMinutes)),
          checkpoint
        )
      );
      const immediate = events.filter(
        (event) => event.immediate && this.#isEventTargetEnabled(event, adapter)
      );
      const enqueued = this.#store.enqueueImmediateEvents(immediate, this.#guildId);
      this.#logger.info("source poll completed", {
        sourceId: adapter.id,
        snapshotCount: snapshots.length,
        eventCount: events.length,
        deliveryCount: enqueued
      });
    } catch (error) {
      if (this.#stopController.signal.aborted) {
        this.#logger.info("source poll cancelled during shutdown", { sourceId: adapter.id });
        return;
      }
      const failures = (previous?.consecutiveFailures ?? 0) + 1;
      const retryMinutes = Math.min(adapter.intervalMinutes, 5 * 2 ** Math.min(failures - 1, 5));
      const healthEvents = this.#store.markSourceFailure(
        adapter.id,
        attemptedAt,
        isoNow(addMinutes(now, retryMinutes)),
        error instanceof Error ? error.message : String(error)
      );
      this.#store.enqueueImmediateEvents(healthEvents, this.#guildId);
      this.#logger.error("source poll failed", {
        sourceId: adapter.id,
        consecutiveFailures: failures,
        retryMinutes,
        ...errorFields(error)
      });
    }
  }

  #isEventTargetEnabled(event: DomainEvent, adapter: SourceAdapter): boolean {
    if (event.type.startsWith("source.")) {
      return adapter.targets.some((target) => this.#store.isWatchTargetEnabled(this.#guildId, target));
    }
    const target = event.leaderboardId ?? `provider-${event.sourceId}`;
    return this.#store.isWatchTargetEnabled(this.#guildId, target);
  }

  #enqueueScheduledDigest(now: Date): void {
    const local = localHourMinute(now, this.#config.timeZone);
    const currentMinute = local.hour * 60 + local.minute;
    const scheduledMinute = this.#config.digestHour * 60 + this.#config.digestMinute;
    if (currentMinute < scheduledMinute) return;
    const dateKey = localDateKey(now, this.#config.timeZone);
    const count = this.#store.enqueueDigest(this.#guildId, dateKey, isoNow(now));
    if (count > 0) this.#logger.info("daily digest enqueued", { dateKey, deliveryCount: count });
  }

  #runRetention(now: Date): void {
    const local = localHourMinute(now, this.#config.timeZone);
    if (local.hour * 60 + local.minute < 3 * 60 + 15) return;
    const dateKey = localDateKey(now, this.#config.timeZone);
    if (this.#lastRetentionDateKey === dateKey) return;
    const result = this.#store.prune(isoNow(now));
    this.#lastRetentionDateKey = dateKey;
    this.#logger.info("retention cleanup completed", { dateKey, ...result });
  }
}

function snapshotTarget(snapshot: SourceSnapshot): string {
  return snapshot.kind === "benchmark" ? snapshot.leaderboardId : `provider-${snapshot.sourceId}`;
}
