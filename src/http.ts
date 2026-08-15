const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT = "ai-benchmark-bot/1.0";

export class HttpError extends Error {
  readonly status?: number;

  constructor(url: string, status?: number) {
    super(status === undefined ? `Source request failed for ${url}` : `Source request failed (${status}) for ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface FetchTextOptions {
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  fetchFn?: typeof globalThis.fetch;
}

export interface FetchTextResult {
  text: string;
  contentType?: string;
}

export async function fetchText(url: string, options: FetchTextOptions = {}): Promise<FetchTextResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Source request timeout must be a positive number");
  }
  const response = await (options.fetchFn ?? globalThis.fetch)(url, {
    headers: { "user-agent": USER_AGENT, ...options.headers },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new HttpError(url, response.status);

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Source response exceeds ${maxBytes} bytes for ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Source response exceeds ${maxBytes} bytes for ${url}`);
  }
  return {
    text: new TextDecoder().decode(bytes),
    contentType: response.headers.get("content-type") ?? undefined
  };
}

export function parseJson(text: string, sourceName: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${sourceName} returned invalid JSON`, { cause: error });
  }
}
