import { sha256 } from "../core/hash.js";
import type { SourceCheckpoint } from "../domain/models.js";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export class SourceHttpError extends Error {
  readonly status: number;
  readonly retryAfter?: string;

  constructor(url: string, response: Response) {
    super(`Source request failed (${response.status}) for ${url}`);
    this.name = "SourceHttpError";
    this.status = response.status;
    this.retryAfter = response.headers.get("retry-after") ?? undefined;
  }
}

export type FetchResourceResult =
  | { status: "not_modified"; checkpoint: SourceCheckpoint }
  | {
      status: "ok";
      text: string;
      contentType?: string;
      checkpoint: SourceCheckpoint;
    };

export interface FetchResourceOptions {
  checkpoint?: SourceCheckpoint;
  headers?: ConstructorParameters<typeof Headers>[0];
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Fetches a source document without retaining it beyond the current poll. The
 * returned checkpoint contains validators plus a SHA-256 digest, never the
 * response body itself.
 */
export async function fetchResource(
  fetchFn: typeof globalThis.fetch,
  url: string,
  options: FetchResourceOptions = {}
): Promise<FetchResourceResult> {
  const headers = new Headers(options.headers);
  headers.set("accept", headers.get("accept") ?? "*/*");
  headers.set("user-agent", headers.get("user-agent") ?? "ai-benchmark-bot/0.1");
  if (options.checkpoint?.etag) headers.set("if-none-match", options.checkpoint.etag);
  if (options.checkpoint?.lastModified) {
    headers.set("if-modified-since", options.checkpoint.lastModified);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Source request timeout must be a positive number");
  }
  const response = await fetchFn(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const responseCheckpoint = responseCheckpointFrom(response, options.checkpoint);
  if (response.status === 304) {
    return { status: "not_modified", checkpoint: responseCheckpoint };
  }
  if (!response.ok) throw new SourceHttpError(url, response);

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Source response exceeds ${maxBytes} bytes for ${url}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Source response exceeds ${maxBytes} bytes for ${url}`);
  }
  const text = new TextDecoder().decode(bytes);
  responseCheckpoint.contentHash = sha256(text);
  return {
    status: "ok",
    text,
    contentType: response.headers.get("content-type") ?? undefined,
    checkpoint: responseCheckpoint
  };
}

export function parseJson(text: string, sourceName: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${sourceName} returned invalid JSON`, { cause: error });
  }
}

function responseCheckpointFrom(
  response: Response,
  previous?: SourceCheckpoint
): SourceCheckpoint {
  const checkpoint: SourceCheckpoint = {};
  const etag = response.headers.get("etag") ?? previous?.etag;
  const lastModified = response.headers.get("last-modified") ?? previous?.lastModified;
  const revision = response.headers.get("x-revision") ?? previous?.revision;
  if (etag) checkpoint.etag = etag;
  if (lastModified) checkpoint.lastModified = lastModified;
  if (revision) checkpoint.revision = revision;
  if (previous?.contentHash) checkpoint.contentHash = previous.contentHash;
  return checkpoint;
}
