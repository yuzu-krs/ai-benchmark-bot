import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pollNewModelAlerts, seenModelKey } from "../src/alerts.js";
import type { ProviderSource, RawAnnouncement } from "../src/announcements/index.js";
import type { Logger } from "../src/logger.js";
import { StateStore } from "../src/state.js";
import type { EmbedPayload } from "../src/types.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

interface CallLog {
  sent: EmbedPayload[];
  failures: number;
}

function okResponse(): Response {
  return new Response("<html>source document</html>", {
    status: 200,
    headers: { "content-type": "text/html" }
  });
}

function source(id: string, raws: () => RawAnnouncement[]): ProviderSource {
  return {
    id,
    providerName: id === "openai" ? "OpenAI" : "Anthropic",
    displayName: `${id} docs`,
    fetchUrl: `https://example.com/${id}`,
    accept: "text/html",
    parse: () => raws()
  };
}

function newModelRaw(modelId: string): RawAnnouncement {
  return {
    key: `launch-${modelId}`,
    title: `We've launched ${modelId}`,
    url: "https://example.com/launch",
    summary: `${modelId} is our new language model for complex reasoning.`,
    explicitModelIds: [modelId]
  };
}

function candidateRaw(): RawAnnouncement {
  return {
    key: "preview-update",
    title: "Gemini 4 model preview update",
    url: "https://example.com/preview",
    summary: "An early model preview is being evaluated with selected developers."
  };
}

interface Harness {
  store: StateStore;
  log: CallLog;
  send: (embed: EmbedPayload) => Promise<void>;
  fetchFn: typeof fetch;
}

function createHarness(sendImpl?: (embed: EmbedPayload) => Promise<void>): Harness {
  const store = new StateStore(mkdtempSync(join(tmpdir(), "alerts-")));
  const log: CallLog = { sent: [], failures: 0 };
  return {
    store,
    log,
    send:
      sendImpl ??
      (async (embed) => {
        log.sent.push(embed);
      }),
    fetchFn: (async () => okResponse()) as typeof fetch
  };
}

const fixedNow = () => new Date("2026-08-16T03:30:00.000Z");

describe("pollNewModelAlerts", () => {
  it("establishes a silent baseline on the first poll", async () => {
    const harness = createHarness();
    const notified = await pollNewModelAlerts({
      timeZone: "Asia/Tokyo",
      store: harness.store,
      logger,
      send: harness.send,
      sources: [source("openai", () => [newModelRaw("gpt-6")])],
      fetchFn: harness.fetchFn,
      now: fixedNow
    });
    expect(notified).toBe(0);
    expect(harness.log.sent).toHaveLength(0);
    expect(harness.store.loadSeenModels().map((model) => model.key)).toEqual([
      seenModelKey("openai", "gpt-6")
    ]);
  });

  it("notifies a newly announced model once and records it as seen", async () => {
    const harness = createHarness();
    harness.store.saveSeenModels([
      { key: seenModelKey("openai", "gpt-5"), providerId: "openai", modelId: "gpt-5", firstSeenAt: "2026-08-01T00:00:00.000Z" }
    ]);
    const sources = [source("openai", () => [newModelRaw("gpt-5"), newModelRaw("gpt-6")])];

    const first = await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources, fetchFn: harness.fetchFn, now: fixedNow
    });
    expect(first).toBe(1);
    expect(harness.log.sent).toHaveLength(1);
    const embed = harness.log.sent[0]!;
    expect(embed.title).toBe("🚀 New Model Alert!");
    const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
    expect(fields["🧠 Model"]).toBe("gpt-6");

    const second = await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources, fetchFn: harness.fetchFn, now: fixedNow
    });
    expect(second).toBe(0);
    expect(harness.log.sent).toHaveLength(1);
  });

  it("skips candidate announcements and only notifies confirmed launches", async () => {
    const harness = createHarness();
    harness.store.saveSeenModels([]);
    await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources: [source("openai", () => [candidateRaw()])],
      fetchFn: harness.fetchFn, now: fixedNow
    });
    expect(harness.log.sent).toHaveLength(0);
  });

  it("keeps an alert pending when the Discord send fails", async () => {
    const harness = createHarness(async () => {
      throw new Error("discord unavailable");
    });
    harness.store.saveSeenModels([]);
    const sources = [source("openai", () => [newModelRaw("gpt-6")])];

    await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources, fetchFn: harness.fetchFn, now: fixedNow
    });
    expect(harness.store.loadSeenModels()).toEqual([]);

    // With Discord healthy again the same alert is retried on the next poll.
    harness.send = async (embed) => {
      harness.log.sent.push(embed);
    };
    const retried = await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources, fetchFn: harness.fetchFn, now: fixedNow
    });
    expect(retried).toBe(1);
  });

  it("isolates provider failures so other providers still notify", async () => {
    const harness = createHarness();
    harness.store.saveSeenModels([]);
    const broken: ProviderSource = {
      id: "anthropic",
      providerName: "Anthropic",
      displayName: "broken",
      fetchUrl: "https://example.com/anthropic",
      accept: "text/html",
      parse: () => {
        throw new Error("structure changed");
      }
    };

    const notified = await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources: [broken, source("openai", () => [newModelRaw("gpt-6")])],
      fetchFn: harness.fetchFn, now: fixedNow
    });
    expect(notified).toBe(1);
    expect(harness.log.sent).toHaveLength(1);
  });
});
