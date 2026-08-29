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

function pricingResponse(models: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ data: models }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/** A catalog entry that matches none of the fixture model ids. */
const UNRELATED_CATALOG_MODEL = {
  id: "unrelated/vendor-model",
  name: "Vendor: Unrelated Model",
  hugging_face_id: null,
  created: 1,
  context_length: 8192,
  pricing: { prompt: "0.0000012", completion: "0.000012" }
};

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
  /** How often the OpenRouter pricing catalog URL was fetched. */
  calls: { openRouter: number };
  setPricingResponder: (responder: () => Promise<Response>) => void;
}

function createHarness(sendImpl?: (embed: EmbedPayload) => Promise<void>): Harness {
  const store = new StateStore(mkdtempSync(join(tmpdir(), "alerts-")));
  const log: CallLog = { sent: [], failures: 0 };
  let pricingResponder: () => Promise<Response> = () =>
    Promise.resolve(pricingResponse([UNRELATED_CATALOG_MODEL]));
  const calls = { openRouter: 0 };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      calls.openRouter += 1;
      return pricingResponder();
    }
    return okResponse();
  }) as typeof fetch;
  return {
    store,
    log,
    send:
      sendImpl ??
      (async (embed) => {
        log.sent.push(embed);
      }),
    fetchFn,
    calls,
    setPricingResponder: (responder) => {
      pricingResponder = responder;
    }
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

  it("attaches resolved prices to the alert embed", async () => {
    const harness = createHarness();
    harness.store.saveSeenModels([
      { key: seenModelKey("openai", "gpt-5"), providerId: "openai", modelId: "gpt-5", firstSeenAt: "2026-08-01T00:00:00.000Z" }
    ]);
    harness.setPricingResponder(() =>
      Promise.resolve(
        pricingResponse([
          {
            id: "openai/gpt-6",
            name: "OpenAI: GPT-6",
            hugging_face_id: null,
            created: 10,
            context_length: 400_000,
            pricing: { prompt: "0.00000125", completion: "0.00001" }
          },
          UNRELATED_CATALOG_MODEL
        ])
      )
    );

    const notified = await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources: [source("openai", () => [newModelRaw("gpt-6")])],
      fetchFn: harness.fetchFn, now: fixedNow
    });

    expect(notified).toBe(1);
    const fields = Object.fromEntries(harness.log.sent[0]!.fields.map((field) => [field.name, field.value]));
    expect(fields["💰 価格 / コンテキスト"]).toBe("$1.25/$10 · 400K");
    // The priced alert still gets recorded as seen like any other.
    expect(harness.store.loadSeenModels().map((model) => model.key)).toContain(
      seenModelKey("openai", "gpt-6")
    );
  });

  it("lists only the models that matched pricing", async () => {
    const harness = createHarness();
    harness.store.saveSeenModels([]);
    harness.setPricingResponder(() =>
      Promise.resolve(
        pricingResponse([
          {
            id: "openai/gpt-6",
            name: "OpenAI: GPT-6",
            hugging_face_id: null,
            created: 10,
            context_length: 400_000,
            pricing: { prompt: "0.00000125", completion: "0.00001" }
          }
        ])
      )
    );
    // One announcement carrying two models: only the matched one gets a line.
    const multiModelRaw: RawAnnouncement = {
      key: "launch-multi",
      title: "We launched two models",
      url: "https://example.com/launch",
      summary: "Two new language models.",
      explicitModelIds: ["gpt-6", "gpt-unknown"]
    };

    await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources: [source("openai", () => [multiModelRaw])],
      fetchFn: harness.fetchFn, now: fixedNow
    });

    const fields = Object.fromEntries(harness.log.sent[0]!.fields.map((field) => [field.name, field.value]));
    expect(fields["💰 価格 / コンテキスト"]).toBe("`gpt-6` — $1.25/$10 · 400K");
  });

  it("posts alerts without a pricing field when nothing matches", async () => {
    const harness = createHarness();
    harness.store.saveSeenModels([]);

    await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources: [source("openai", () => [newModelRaw("gpt-6")])],
      fetchFn: harness.fetchFn, now: fixedNow
    });

    const fieldNames = harness.log.sent[0]!.fields.map((field) => field.name);
    expect(fieldNames).not.toContain("💰 価格 / コンテキスト");
  });

  it("posts alerts without prices when OpenRouter fails and still records them", async () => {
    const harness = createHarness();
    harness.store.saveSeenModels([]);
    harness.setPricingResponder(() => Promise.resolve(new Response("down", { status: 500 })));

    const notified = await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources: [source("openai", () => [newModelRaw("gpt-6")])],
      fetchFn: harness.fetchFn, retryDelayMs: 0, now: fixedNow
    });

    expect(notified).toBe(1);
    const fieldNames = harness.log.sent[0]!.fields.map((field) => field.name);
    expect(fieldNames).not.toContain("💰 価格 / コンテキスト");
    expect(harness.store.loadSeenModels().map((model) => model.key)).toEqual([
      seenModelKey("openai", "gpt-6")
    ]);
  });

  it("keeps the alert pending when both pricing and sending fail", async () => {
    const harness = createHarness(async () => {
      throw new Error("discord unavailable");
    });
    harness.store.saveSeenModels([]);
    harness.setPricingResponder(() => Promise.resolve(new Response("down", { status: 500 })));
    const sources = [source("openai", () => [newModelRaw("gpt-6")])];

    await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources, fetchFn: harness.fetchFn, retryDelayMs: 0, now: fixedNow
    });
    expect(harness.store.loadSeenModels()).toEqual([]);

    // With Discord healthy again the same alert is retried on the next poll.
    harness.send = async (embed) => {
      harness.log.sent.push(embed);
    };
    const retried = await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources, fetchFn: harness.fetchFn, retryDelayMs: 0, now: fixedNow
    });
    expect(retried).toBe(1);
  });

  it("skips the pricing catalog entirely on the baseline poll", async () => {
    const harness = createHarness();

    const notified = await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources: [source("openai", () => [newModelRaw("gpt-6")])],
      fetchFn: harness.fetchFn, now: fixedNow
    });

    expect(notified).toBe(0);
    expect(harness.calls.openRouter).toBe(0);
  });

  it("shares one pricing fetch across multiple alerts in a run", async () => {
    const harness = createHarness();
    harness.store.saveSeenModels([]);
    const sources = [
      source("openai", () => [newModelRaw("gpt-6")]),
      source("anthropic", () => [newModelRaw("claude-x")])
    ];

    const notified = await pollNewModelAlerts({
      timeZone: "Asia/Tokyo", store: harness.store, logger, send: harness.send,
      sources, fetchFn: harness.fetchFn, now: fixedNow
    });

    expect(notified).toBe(2);
    expect(harness.log.sent).toHaveLength(2);
    expect(harness.calls.openRouter).toBe(1);
  });
});
