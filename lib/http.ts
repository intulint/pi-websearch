/**
 * Unified HTTP client — GET/POST over node:https / node:http.
 * Handles redirects, gzip/br/deflate decompression, timeouts, abort signals.
 */

import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";

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
  body: string; // raw buffer as string (caller should not use — use decompressedBody)
  decompressedBody: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

// Load clients once at module level — Node caches dynamic imports automatically
const clientModules = (() => {
  // Use top-level imports to avoid dynamic import overhead on every request
  return {
    https: null as typeof import("node:https") | null,
    http: null as typeof import("node:http") | null,
  };
})();

async function getClients(): Promise<{
  https: typeof import("node:https");
  http: typeof import("node:http");
}> {
  if (!clientModules.https) {
    const [https, http] = await Promise.all([import("node:https"), import("node:http")]);
    clientModules.https = https;
    clientModules.http = http;
  }
  return { https: clientModules.https!, http: clientModules.http! };
}

function decompress(body: Buffer, contentEncoding?: string | undefined): Buffer {
  if (!contentEncoding) return body;
  try {
    switch (contentEncoding) {
      case "gzip":
        return gunzipSync(body);
      case "br":
        return brotliDecompressSync(body);
      case "deflate":
        return inflateSync(body);
      default:
        return body;
    }
  } catch {
    return body; // fallback: return raw
  }
}

const MAX_REDIRECTS = 10;

async function executeRequest(
  method: "GET" | "POST",
  url: string,
  { headers, body, timeoutMs = 30000, signal }: RequestOptions & { body?: string },
  redirectsLeft = MAX_REDIRECTS,
): Promise<{
  status: number;
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
  contentEncoding: string | undefined;
}> {
  const { https, http } = await getClients();
  const reqFn = url.startsWith("https:") ? https.request : http.request;

  if (redirectsLeft <= 0) {
    throw new Error("Too many redirects");
  }

  return new Promise<{
    status: number;
    headers: Record<string, string | undefined>;
    rawBody: Buffer;
    contentEncoding: string | undefined;
  }>((resolve, reject) => {
    const req = reqFn(
      url,
      {
        method,
        timeout: timeoutMs,
        headers,
      },
      (res) => {
        const contentEncoding = res.headers["content-encoding"];
        const location = res.headers.location;

        // Redirect (3xx with location)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
          res.resume(); // consume body to free memory
          // POST redirects become GET (standard HTTP behavior)
          const redirectMethod = method === "POST" ? "GET" : method;
          executeRequest(redirectMethod, location, { headers, timeoutMs, signal }, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const headersMap: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            headersMap[k] = typeof v === "string" ? v : v?.[0];
          }
          resolve({ status: res.statusCode ?? 0, headers: headersMap, rawBody: Buffer.concat(chunks), contentEncoding });
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        req.destroy();
        reject(new Error("Request aborted"));
      });
    }

    if (body) req.write(body);
    req.end();
  });
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
    const text = decompress(rawBody, contentEncoding).toString("utf-8").slice(0, 500);
    throw new Error(`HTTP ${status}: ${text}`);
  }

  return decompress(rawBody, contentEncoding).toString("utf-8");
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
    const text = decompress(rawBody, contentEncoding).toString("utf-8").slice(0, 500);
    throw new Error(`HTTP ${status}: ${text}`);
  }

  const decompressed = decompress(rawBody, contentEncoding).toString("utf-8");
  return {
    status,
    headers,
    body: rawBody.toString("utf-8"), // raw (possibly compressed) body as string
    decompressedBody: decompressed,  // always decompressed
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
    const text = rawBody.toString("utf-8").slice(0, 500);
    throw new Error(`HTTP ${status}: ${text}`);
  }

  try {
    return JSON.parse(rawBody.toString("utf-8"));
  } catch (e) {
    throw new Error(`Invalid JSON response: ${(e as Error).message}`);
  }
}
