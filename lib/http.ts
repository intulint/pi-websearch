/**
 * Unified HTTP client — GET/POST via undici (respects HTTP_PROXY/HTTPS_PROXY).
 * Handles redirects, gzip/br/deflate decompression, timeouts, abort signals.
 */

import { fetch, ProxyAgent, Dispatcher } from "undici";
import type { RequestInit, Response } from "undici";

// ============================================================================
// Proxy setup — undici reads HTTP_PROXY / HTTPS_PROXY via ProxyAgent
// ============================================================================

let _dispatcher: Dispatcher | undefined;

function getDispatcher(): Dispatcher {
  if (_dispatcher) return _dispatcher;

  const proxyUrl =
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.ALL_PROXY;

  if (!proxyUrl) {
    _dispatcher = new Dispatcher(); // default no-op dispatcher
    return _dispatcher;
  }

  // Build NO_PROXY set
  const noProxy = (process.env.NO_PROXY || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  _dispatcher = new ProxyAgent({
    uri: proxyUrl,
    proxyTunnel: false,
    requestTls: {
      rejectUnauthorized: false,
    },
  });

  return _dispatcher;
}

// ============================================================================
// Types
// ============================================================================

export interface RequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface FetchResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
  decompressedBody: string;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_REDIRECTS = 10;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// ============================================================================
// Internal helpers
// ============================================================================

function decompressBody(body: Uint8Array, contentEncoding?: string): string {
  const text = new TextDecoder().decode(body);
  if (!contentEncoding) return text;
  try {
    switch (contentEncoding) {
      case "gzip": {
        const zlib = require("node:zlib");
        return zlib.gunzipSync(Buffer.from(body)).toString("utf-8");
      }
      case "br": {
        const zlib = require("node:zlib");
        return zlib.brotliDecompressSync(Buffer.from(body)).toString("utf-8");
      }
      case "deflate": {
        const zlib = require("node:zlib");
        return zlib.inflateSync(Buffer.from(body)).toString("utf-8");
      }
      default:
        return text;
    }
  } catch {
    return text;
  }
}

async function executeRequest(
  method: "GET" | "POST",
  url: string,
  options: RequestOptions & { body?: string },
  redirectsLeft = MAX_REDIRECTS,
): Promise<{
  status: number;
  headers: Record<string, string | undefined>;
  rawBody: Uint8Array;
  contentEncoding: string | undefined;
}> {
  if (redirectsLeft <= 0) {
    throw new Error("Too many redirects");
  }

  const allHeaders: Record<string, string> = {
    "User-Agent": DEFAULT_USER_AGENT,
    "Accept": "text/html,application/json,*/*",
    "Accept-Encoding": "gzip, br, deflate",
    ...options.headers,
  };

  let fetchTimeout: AbortSignal | undefined;
  if (options.timeoutMs) {
    fetchTimeout = AbortSignal.timeout(options.timeoutMs);
  }

  const init: RequestInit = {
    method,
    headers: allHeaders,
    redirect: "manual",
    signal: options.signal ?? fetchTimeout,
  };

  if (method === "POST" && options.body) {
    init.body = options.body;
  }

  const response = await fetch(url, {
    ...init,
    dispatcher: getDispatcher(),
  }) as Response;

  // Handle redirect (3xx with location header)
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect ${response.status} without location header`);
    }
    const redirectMethod = method === "POST" ? "GET" : method;
    return executeRequest(redirectMethod, location, options, redirectsLeft - 1);
  }

  const arrayBuffer = await response.arrayBuffer();
  const rawBody = new Uint8Array(arrayBuffer);
  const contentEncoding = response.headers.get("content-encoding") ?? undefined;

  const headers: Record<string, string | undefined> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return { status: response.status, headers, rawBody, contentEncoding };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * GET request with redirect following and automatic decompression. Returns text body.
 */
export async function httpGet(
  url: string,
  options: RequestOptions = {},
): Promise<string> {
  const { status, rawBody, contentEncoding } = await executeRequest("GET", url, options);

  if (status < 200 || status >= 300) {
    const text = decompressBody(rawBody, contentEncoding).slice(0, 500);
    throw new Error(`HTTP ${status}: ${text}`);
  }

  return decompressBody(rawBody, contentEncoding);
}

/**
 * GET request returning full response metadata + decompressed body.
 */
export async function httpGetRaw(
  url: string,
  options: RequestOptions = {},
): Promise<FetchResponse> {
  const { status, headers, rawBody, contentEncoding } = await executeRequest("GET", url, options);

  if (status < 200 || status >= 300) {
    const text = decompressBody(rawBody, contentEncoding).slice(0, 500);
    throw new Error(`HTTP ${status}: ${text}`);
  }

  const decompressed = decompressBody(rawBody, contentEncoding);
  return {
    status,
    headers,
    body: new TextDecoder().decode(rawBody),
    decompressedBody: decompressed,
  };
}

/**
 * POST JSON request. Returns parsed JSON body.
 */
export async function httpPostJson(
  url: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<unknown> {
  const payload = JSON.stringify(body);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(payload)),
    ...options.headers,
  };

  const { status, rawBody } = await executeRequest("POST", url, {
    headers,
    body: payload,
    timeoutMs: options.timeoutMs ?? 60000,
    signal: options.signal,
  });

  if (status < 200 || status >= 300) {
    const text = new TextDecoder().decode(rawBody).slice(0, 500);
    throw new Error(`HTTP ${status}: ${text}`);
  }

  try {
    return JSON.parse(new TextDecoder().decode(rawBody));
  } catch (e) {
    throw new Error(`Invalid JSON response: ${(e as Error).message}`);
  }
}
