import { pollNewModelAlerts } from "./alerts.js";
import type { ProviderSource } from "./announcements/index.js";
import type { AppConfig } from "./config.js";
import { errorFields, type Logger } from "./logger.js";
import { runDailyRanking } from "./ranking.js";
import type { StateStore } from "./state.js";
import { addMinutes, localDateKey, localHourMinute } from "./time.js";
import type { EmbedPayload } from "./types.js";

const TICK_INTERVAL_MS = 60_000;

export interface SchedulerDeps {
  config: AppConfig;
  store: StateStore;
  logger: Logger;
  send(embed: EmbedPayload): Promise<void>;
  /** Injectable for tests; production uses the global fetch. */
  fetchFn?: typeof globalThis.fetch;
  sources?: readonly ProviderSource[];
  now?: () => Date;
}

/**
 * One-minute tick that drives both jobs:
 * - Daily Ranking once per local day after DIGEST_HOUR/DIGEST_MINUTE
 *   (last-posted.json prevents duplicates and enables startup catch-up).
 * - New Model Alert polling every ALERT_POLL_MINUTES.
 */
export class Scheduler {
  readonly #deps: SchedulerDeps;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #stopped = false;
  #nextAlertPollAt = new Date(0);

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
  }

  start(): void {
    void this.#pollAlerts();
    // The interval is intentionally left ref'd: with a REST-only Discord
    // client there is no gateway connection keeping the process alive.
    this.#timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    while (this.#running) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async tick(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      const now = this.#deps.now?.() ?? new Date();
      await this.#maybeRunRanking(now);
      if (now >= this.#nextAlertPollAt) {
        await this.#pollAlerts(now);
      }
    } catch (error) {
      this.#deps.logger.error("scheduler tick failed", errorFields(error));
    } finally {
      this.#running = false;
    }
  }

  async #maybeRunRanking(now: Date): Promise<void> {
    const { timeZone, digestHour, digestMinute } = this.#deps.config;
    const local = localHourMinute(now, timeZone);
    if (local.hour * 60 + local.minute < digestHour * 60 + digestMinute) return;
    const dateKey = localDateKey(now, timeZone);
    if (this.#deps.store.loadLastPosted()?.dateKey === dateKey) return;
    try {
      await runDailyRanking({
        timeZone,
        store: this.#deps.store,
        logger: this.#deps.logger,
        send: this.#deps.send,
        fetchFn: this.#deps.fetchFn,
        ...(this.#deps.now ? { now: this.#deps.now } : {}),
      });
    } catch (error) {
      // A failed post leaves last-posted.json untouched, so the next tick
      // retries the ranking for the same day.
      this.#deps.logger.error("daily ranking failed", errorFields(error));
    }
  }

  async #pollAlerts(now?: Date): Promise<void> {
    if (this.#stopped) return;
    const current = now ?? this.#deps.now?.() ?? new Date();
    this.#nextAlertPollAt = addMinutes(
      current,
      this.#deps.config.alertPollMinutes,
    );
    try {
      await pollNewModelAlerts({
        timeZone: this.#deps.config.timeZone,
        store: this.#deps.store,
        logger: this.#deps.logger,
        send: this.#deps.send,
        fetchFn: this.#deps.fetchFn,
        ...(this.#deps.sources ? { sources: this.#deps.sources } : {}),
        ...(this.#deps.now ? { now: this.#deps.now } : {}),
      });
    } catch (error) {
      this.#deps.logger.error("provider polling failed", errorFields(error));
    }
  }
}
