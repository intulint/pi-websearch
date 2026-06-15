/**
 * pi-websearch — Web search and structured content extraction tools for Pi.
 *
 * Tools:
 *   - get_current_date — Returns current date in ISO format
 *   - search_web       — Web search via DuckDuckGo HTML scraping
 *   - extract          — Fetches URLs, extracts readable content via local LLM
 *
 * Model selection (priority):
 *   1. .env (LLM_URL + LLM_MODEL) — explicit override
 *   2. Pi's currently active model (auto-detected)
 *
 * Install deps: npm install && npx playwright install chromium
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Module-level initialisation
// ============================================================================

const EXTENSION_DIR = dirname(new URL(import.meta.url).pathname);
const TOOL_CALL_LOG_PATH = join(EXTENSION_DIR, "tool_calls.log.json");

// Env values are read lazily at runtime (not at module init),
// so they survive jiti cache / /reload without session reset.
function getEnvConfig(): { url: string; model: string; apiKey: string } {
  return {
    url: process.env.LLM_URL || "",
    model: process.env.LLM_MODEL || "",
    apiKey: process.env.LLM_API_KEY || "",
  };
}

let lastEnvRead = "";
let cachedEnvUrl = "";
let cachedEnvModel = "";
let cachedEnvApiKey = "";

function ensureEnvLoaded(): void {
  const fresh = getEnvConfig();
  if (lastEnvRead !== EXTENSION_DIR) {
    loadEnvFile(join(EXTENSION_DIR, ".env"));
    const reloaded = getEnvConfig();
    cachedEnvUrl = reloaded.url;
    cachedEnvModel = reloaded.model;
    cachedEnvApiKey = reloaded.apiKey;
    lastEnvRead = EXTENSION_DIR;
  }
}

let detectedModelId = "";
let detectedBaseUrl = "";
let detectedApiKey = "";
let extractAllowed = true;

// ============================================================================
// Env loader
// ============================================================================

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = value;
    }
  } catch { /* ignore */ }
}

// ============================================================================
// Model resolution
// ============================================================================

function resolveModel(): { url: string; model: string; apiKey?: string } | null {
  ensureEnvLoaded();
  if (cachedEnvUrl && cachedEnvModel) {
    return { url: cachedEnvUrl, model: cachedEnvModel, apiKey: cachedEnvApiKey || undefined };
  }
  if (detectedModelId && detectedBaseUrl) return { url: detectedBaseUrl, model: detectedModelId, apiKey: detectedApiKey || undefined };
  return null;
}

function buildChatUrl(baseUrl: string): string {
  const url = baseUrl.trim();
  if (url.includes("/v1/chat/completions") || url.endsWith("/v1"))
    return url.endsWith("/chat/completions") ? url : `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

function resolveModelFromPi(
  source: { id?: string; provider?: string; baseUrl?: string } | undefined,
  registry: { find: (p: string, id: string) => { baseUrl?: string; apiKey?: string } | undefined } | undefined,
): void {
  if (!source?.id) return;
  const id = source.id;
  detectedModelId = id;
  const baseUrl = source.baseUrl || "";
  if (baseUrl) {
    detectedBaseUrl = baseUrl;
  } else if (registry) {
    const found = registry.find(source.provider ?? "", id);
    if (found?.baseUrl) detectedBaseUrl = found.baseUrl;
    if (found?.apiKey) detectedApiKey = found.apiKey;
  }
}

// ============================================================================
// TypeBox schemas
// ============================================================================

const SearchWebParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of results (default: 10)" }),
  ),
});

export type SearchWebParamsType = Static<typeof SearchWebParams>;

const ExtractParams = Type.Object({
  urls: Type.Array(Type.String(), { description: "URLs to extract from" }),
  prompt: Type.Optional(
    Type.String({ description: "What data to extract from the page content" }),
  ),
  schema: Type.Optional(
    Type.Unknown({ description: "JSON schema for the output format" }),
  ),
  useBrowser: Type.Optional(
    Type.Boolean({
      description: "Use Playwright browser for JS-heavy sites (default: true)",
    }),
  ),
});

export type ExtractParamsType = Static<typeof ExtractParams>;

// ============================================================================
// HTTP helpers
// ============================================================================

async function httpGet(url: string, timeoutMs = 30000): Promise<string> {
  const { request } = await import("node:https");
  const { request: httpRequest } = await import("node:http");
  const { URL } = await import("node:url");

  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? request : httpRequest;

  return new Promise((resolve, reject) => {
    const req = client(
      url,
      {
        timeout: timeoutMs,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "identity",
          Connection: "keep-alive",
        },
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf-8").slice(0, 200)}`,
              ),
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.end();
  });
}

async function httpPostJson(
  url: string,
  body: unknown,
  timeoutMs = 60000,
  apiKey?: string,
): Promise<unknown> {
  const { request } = await import("node:https");
  const { request: httpRequest } = await import("node:http");
  const { URL } = await import("node:url");

  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? request : httpRequest;
  const payload = JSON.stringify(body);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(payload)),
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return new Promise((resolve, reject) => {
    const req = client(
      url,
      {
        method: "POST",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf-8").slice(0, 500)}`,
              ),
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (e) {
            reject(
              new Error(`Invalid JSON response: ${(e as Error).message}`),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.write(payload);
    req.end();
  });
}

// ============================================================================
// Content processing
// ============================================================================

function htmlToClean(html: string): string {
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/[^\S\n]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : "";
}

// ============================================================================
// DuckDuckGo search
// ============================================================================

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function decodeDdgUrl(href: string): string {
  if (href.startsWith("//duckduckgo.com/l/?uddg="))
    return decodeURIComponent(href.split("uddg=")[1].split("&")[0]);
  if (href.startsWith("//")) return "https:" + href;
  return href;
}

async function searchDdg(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const ddgQuery = query.trim();
  if (!ddgQuery) throw new Error("Search query cannot be empty");

  const fullQuery = `${ddgQuery} -site:grokipedia.com`;
  const { request } = await import("node:https");
  const { gunzipSync, brotliDecompressSync } = await import("node:zlib");
  const { URL } = await import("node:url");

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(fullQuery)}&b=0&p=1&s=0&df=y`;

  const headers = {
    "User-Agent": getRandomUserAgent(),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-GPC": "1",
    "Cache-Control": "max-age=0",
    "sec-ch-ua": '"Chromium";v="146", "Not=A?Brand";v="8"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };

  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { headers, timeout: 15000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf-8");

          if (res.headers["content-encoding"] === "gzip") {
            html = gunzipSync(Buffer.concat(chunks)).toString("utf-8");
          } else if (res.headers["content-encoding"] === "br") {
            html = brotliDecompressSync(Buffer.concat(chunks)).toString(
              "utf-8",
            );
          }

          if (res.statusCode !== 200) {
            reject(
              new Error(`HTTP ${res.statusCode}: Failed to fetch search results`),
            );
            return;
          }

          if (html.includes("challenge-form")) {
            reject(
              new Error(
                "DuckDuckGo detected an anomaly in the request. Please try again later.",
              ),
            );
            return;
          }

          const resultBlocks = html.match(
            /<div class="result[^"]*results_links[^"]*"[^>]*>[\s\S]*?(?=<div class="result[^"]*results_links|$)/g,
          );
          const results: SearchResult[] = [];

          if (resultBlocks) {
            for (let i = 0; i < Math.min(limit, resultBlocks.length); i++) {
              const block = resultBlocks[i];

              const titleMatch = block.match(
                /<h2[^>]*>[\s\S]*?<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/,
              );
              const title = titleMatch
                ? titleMatch[1].replace(/<[^>]+>/g, " ").trim()
                : "";
              if (!title) continue;

              const urlMatch = block.match(
                /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"/,
              );
              const searchUrl = urlMatch ? decodeDdgUrl(urlMatch[1]) : "";
              if (!searchUrl) continue;

              const snippetMatch = block.match(
                /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
              );
              const description = snippetMatch
                ? snippetMatch[1].replace(/<[^>]+>/g, " ").trim()
                : "";

              results.push({ title, url: searchUrl, description });
            }
          }

          resolve(results);
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.end();
  });
}

// ============================================================================
// Tool call logging
// ============================================================================

function logToolCall(
  toolName: string,
  args: unknown,
  result: string,
): void {
  let logs: Array<{
    logged_at: string;
    tool: string;
    arguments: unknown;
    result: string;
  }> = [];

  if (existsSync(TOOL_CALL_LOG_PATH)) {
    try {
      logs = JSON.parse(readFileSync(TOOL_CALL_LOG_PATH, "utf-8"));
    } catch {
      logs = [];
    }
  }
  logs.push({
    logged_at: new Date().toISOString(),
    tool: toolName,
    arguments: args,
    result,
  });
  if (logs.length > 10) logs = logs.slice(-10);
  try {
    writeFileSync(TOOL_CALL_LOG_PATH, JSON.stringify(logs, null, 2));
  } catch { /* ignore */ }
}

// ============================================================================
// Content extraction
// ============================================================================

async function fetchPageWithBrowser(
  url: string,
  timeoutMs = 60000,
): Promise<{ title: string; text: string; error?: string }> {
  let browser;
  try {
    const { chromium: playwrightChromium } = await import("playwright");
    browser = await playwrightChromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(2000);

    const title = await page.title();
    const text = await page.evaluate(() => {
      document
        .querySelectorAll("script, style, nav, footer, header, aside")
        .forEach((el) => el.remove());
      const t = document.body?.innerText || "";
      return t.replace(/\n{3,}/g, "\n\n").replace(/[^\S\n]+/g, " ").trim();
    });

    return { title: title || url, text: text || (await page.evaluate(() => document.body?.innerText || "")).trim() };
  } catch (e) {
    return { title: url, text: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function fetchPage(
  url: string,
  useBrowser: boolean,
): Promise<{ title: string; text: string; error?: string }> {
  if (useBrowser) return fetchPageWithBrowser(url);

  try {
    const html = await httpGet(url, 60000);
    const title = extractTitle(html) || url;
    let text = htmlToClean(html);
    if (text.length < 50) {
      text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .trim();
    }
    return { title, text };
  } catch (e) {
    return {
      title: url,
      text: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function llmExtract(
  content: string,
  prompt: string | null,
  schema: unknown | null,
): Promise<string> {
  let systemMsg = [
    "You are a data extraction assistant.",
    "Extract the requested information from the provided web page content.",
    "Be precise and only return the extracted data.",
    "Be as detailed as possible without including extra information.",
    "NEVER return an empty result.",
    "If you cannot find the requested data, you MUST explain why — e.g. the page didn't contain it, the content was blocked, the page was a login wall, etc.",
  ].join("\n");

  if (schema) {
    systemMsg += `\n\nReturn the data as JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
  }

  const userContent = prompt
    ? `${content}\n\n---\nExtraction request: ${prompt}`
    : content;

  const llmConfig = resolveModel();
  if (!llmConfig) {
    throw new Error(
      "No LLM configuration found. Set LLM_URL and LLM_MODEL in .env, or switch to a model in pi first.",
    );
  }

  const chatUrl = buildChatUrl(llmConfig.url);
  const response = await httpPostJson(
    chatUrl,
    {
      model: llmConfig.model,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
    },
    600000,
    llmConfig.apiKey,
  );

  const data = response as Record<string, unknown>;
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const contentBlocks = choices?.[0]?.message as
    | { content?: string }
    | undefined;

  if (!contentBlocks?.content) {
    throw new Error("No content in LLM response");
  }
  return contentBlocks.content;
}

async function extractContent(
  urls: string[],
  prompt: string | null = null,
  schema: unknown | null = null,
  useBrowser: boolean = true,
): Promise<string> {
  if (!prompt && !schema) {
    const err = JSON.stringify({ error: "At least one of prompt or schema is required." });
    logToolCall("extract", { urls }, err);
    return err;
  }

  const parts: string[] = [];
  for (const url of urls) {
    const result = await fetchPage(url, useBrowser);
    if (result.error) {
      parts.push(`=== ${url} ===\nFailed to fetch: ${result.error}`);
    } else {
      let text = result.text;
      if (text.length > 12000) text = text.slice(0, 12000) + "\n... [truncated]";
      parts.push(`=== ${url} ===\n${result.title}\n\n${text}`);
    }
  }

  const combined = parts.join("\n\n");
  const result = await llmExtract(combined, prompt, schema);
  logToolCall("extract", { urls, prompt, schema, useBrowser }, result);
  return result;
}

// ============================================================================
// Pi extension
// ============================================================================

export default function piWebsearch(pi: ExtensionAPI): void {
  // --- Model events ---

  pi.on("session_start", async (_event, ctx) => {
    resolveModelFromPi(ctx.model, ctx.modelRegistry);
    ensureEnvLoaded();
    if (cachedEnvUrl && cachedEnvModel) {
      console.log(
        `pi-websearch: LLM configured — URL: ${cachedEnvUrl}, Model: ${cachedEnvModel}`,
      );
    }
  });

  pi.on("model_select", async (event, _ctx) => {
    const m = event.model as { id: string; baseUrl: string } | undefined;
    if (m?.id) {
      detectedModelId = m.id;
      if (m.baseUrl) detectedBaseUrl = m.baseUrl;
    }
  });

  pi.on("turn_start", () => {
    extractAllowed = true;
  });

  // --- Tool: get_current_date ---

  pi.registerTool({
    name: "get_current_date",
    label: "Current Date",
    description:
      "Get the current date in ISO format (YYYY-MM-DD) with day of week.",
    parameters: Type.Object({}) as any,
    async execute() {
      const now = new Date();
      const isoDate = now.toISOString().split("T")[0];
      const dayNames = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      return {
        content: [
          { type: "text", text: `${isoDate} (${dayNames[now.getUTCDay()]})` },
        ],
        details: {},
      };
    },
  });

  // --- Tool: search_web ---

  pi.registerTool({
    name: "search_web",
    label: "Web Search",
    description:
      "Search the web for a query. Returns titles, URLs, and snippet descriptions. Uses DuckDuckGo HTML scraping. WARNING: Do NOT call this tool multiple times in a row — rate limits apply. Wait between calls.",
    parameters: SearchWebParams as any,
    async execute(_toolCallId, params: SearchWebParamsType, _signal, _onUpdate, _ctx) {
      const limit = params.limit || 10;
      const data = await searchDdg(params.query, limit);
      const result = JSON.stringify(data, null, 2);
      logToolCall("search_web", { query: params.query, limit, provider: "ddg" }, result);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // --- Tool: extract ---

  pi.registerTool({
    name: "extract",
    label: "Extract Content",
    description:
      "Extract structured data from one or more URLs. Fetches pages (with optional Playwright browser mode), extracts readable content, then sends to local LLM for structured extraction. Use search_web first to find URLs.",
    parameters: ExtractParams as any,
    async execute(_toolCallId, params: ExtractParamsType, _signal, _onUpdate, _ctx) {
      if (!extractAllowed) {
        return {
          content: [
            {
              type: "text",
              text: "Extract tool is already running in this batch. Only one extract call is allowed per batch.",
            },
          ],
          details: {},
        };
      }
      extractAllowed = false;
      try {
        const result = await extractContent(
          params.urls,
          params.prompt || null,
          params.schema || null,
          params.useBrowser !== false,
        );
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e) {
        extractAllowed = true; // Reset on error so next turn can retry
        throw e;
      }
    },
  });
}
