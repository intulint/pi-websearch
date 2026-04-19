/**
 * pi-webmcp - Web search and content extraction tools for Pi coding agent
 *
 * Pure TypeScript extension (no MCP layer). Provides:
 * - search_web: Search the web using DuckDuckGo (via duck-duck-scrape)
 * - extract: Extract structured data from URLs using the currently active LLM
 * - get_current_date: Get the current date
 *
 * Installation:
 * 1. Copy this extension to ~/.pi/agent/extensions/pi-webmcp
 * 2. Optionally configure SEARCH_PROVIDER and SEARXNG_URL in .env
 * 3. Run: /reload
 *
 * Auto-detection: The extension automatically detects the currently active
 * model in pi and uses its configured LLM endpoint (from models.json).
 * Fallback to .env variables if model info is unavailable.
 *
 * Environment variables (fallback only):
 * - LLM_URL: Local LLM endpoint (e.g., http://localhost:1234/v1)
 * - LLM_MODEL: Model name (e.g., qwen3.5-27b)
 * - SEARCH_PROVIDER: Optional. "ddg" (default) or "searxng"
 * - SEARXNG_URL: Required when SEARCH_PROVIDER=searxng
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { search, SafeSearchType } from "duck-duck-scrape";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { chromium } from "playwright";

// ============================================================================
// Configuration
// ============================================================================

const TOOL_CALL_LOG_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "tool_calls.log.json"
);

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore errors
  }
}

// Load .env from extension directory (fallback only)
loadEnvFile(join(dirname(new URL(import.meta.url).pathname), ".env"));

const FALLBACK_LLM_URL = process.env.LLM_URL || "";
const FALLBACK_LLM_MODEL = process.env.LLM_MODEL || "";
const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || "ddg").toLowerCase().trim();
const SEARXNG_URL = process.env.SEARXNG_URL || "";

// Current model info (auto-detected from pi)
let currentModelId = "";
let currentProviderBaseUrl = "";
let modelDetected = false;

function getModelInfo(): { url: string; model: string } | null {
  // Priority: auto-detected model > env vars
  if (currentModelId && currentProviderBaseUrl) {
    return { url: currentProviderBaseUrl, model: currentModelId };
  }
  if (FALLBACK_LLM_URL && FALLBACK_LLM_MODEL) {
    return { url: FALLBACK_LLM_URL, model: FALLBACK_LLM_MODEL };
  }
  return null;
}

function logConfigStatus(): void {
  const info = getModelInfo();
  if (info) {
    console.log(
      `pi-webmcp: LLM configured — URL: ${info.url}, Model: ${info.model}`
    );
  } else {
    console.warn(
      "pi-webmcp: No LLM configuration found.\n" +
      "Set LLM_URL and LLM_MODEL in .env, or switch to a model in pi."
    );
  }
}

// ============================================================================
// LLM URL Helper — smart /v1 prefix handling
// ============================================================================

function buildChatCompletionsUrl(baseUrl: string): string {
  const url = baseUrl.trim();
  // Check if URL already contains /v1/chat/completions or /v1
  if (url.includes("/v1/chat/completions") || url.endsWith("/v1")) {
    return url.endsWith("/chat/completions") ? url : `${url}/chat/completions`;
  }
  // Add /v1/chat/completions
  return `${url}/v1/chat/completions`;
}

// ============================================================================
// HTTP Helpers
// ============================================================================

async function httpGet(url: string, timeoutMs = 30000): Promise<string> {
  const https = await import("https");
  const http = await import("http");
  const { URL } = await import("url");

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(url, {
      timeout: timeoutMs,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Redirect
        httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf-8").slice(0, 200)}`));
        });
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

async function httpPostJson(url: string, body: unknown, timeoutMs = 60000): Promise<unknown> {
  const https = await import("https");
  const http = await import("http");
  const { URL } = await import("url");

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body);
    const req = client.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf-8").slice(0, 500)}`));
        });
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${(e as Error).message}`));
        }
      });
    });
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
// Content Processing
// ============================================================================

function htmlToClean(html: string): string {
  // Strip scripts and styles
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Strip all other tags
  text = text.replace(/<[^>]+>/g, " ");
  // Collapse whitespace
  text = text.replace(/[^\S\n]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : "";
}

// ============================================================================
// Web Search
// ============================================================================

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

async function searchDdg(query: string, limit: number): Promise<SearchResult[]> {
  // Use duck-duck-scrape library (replaces fragile HTML regex parsing)
  const ddgQuery = query ? query.trim() : "";
  
  let results = await search(ddgQuery, {
    safeSearch: SafeSearchType.MODERATE,
    maxResults: limit,
  });

  return results.results
    .filter(r => r.title && r.url)
    .map(r => ({
      title: r.title.replace(/&amp;/g, "&").replace(/&#x27;/g, "'"),
      url: r.url,
      description: (r.description || "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'"),
    }))
    .slice(0, limit);
}

async function searchSearxng(query: string, limit: number): Promise<SearchResult[]> {
  if (!SEARXNG_URL) {
    throw new Error("SEARXNG_URL is required when SEARCH_PROVIDER=searxng");
  }

  const baseUrl = SEARXNG_URL.replace(/\/$/, "");
  const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  
  const jsonStr = await httpGet(searchUrl, 20000);
  const data = JSON.parse(jsonStr) as Record<string, unknown>;
  
  const results = (data.results as Array<Record<string, unknown>>) || [];
  
  return results.slice(0, limit).map((r) => ({
    title: (r.title as string) || "",
    url: (r.url as string) || "",
    description: (r.content as string) || "",
  }));
}

async function searchWeb(query: string, limit: number = 10): Promise<string> {
  let data: SearchResult[];
  
  if (SEARCH_PROVIDER === "searxng") {
    data = await searchSearxng(query, limit);
  } else {
    data = await searchDdg(query, limit);
  }
  
  logToolCall("search_web", { query, limit, provider: SEARCH_PROVIDER }, JSON.stringify(data));
  return JSON.stringify(data, null, 2);
}

// ============================================================================
// Tool Call Logging
// ============================================================================

function logToolCall(toolName: string, arguments_: unknown, result: string): void {
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

  const entry = {
    logged_at: new Date().toISOString(),
    tool: toolName,
    arguments: arguments_,
    result,
  };

  logs.push(entry);
  // Keep only last 10 entries
  if (logs.length > 10) {
    logs = logs.slice(-10);
  }

  try {
    writeFileSync(TOOL_CALL_LOG_PATH, JSON.stringify(logs, null, 2));
  } catch {
    // Ignore write errors
  }
}

// ============================================================================
// Content Extraction — with Browser Mode (Playwright)
// ============================================================================

async function fetchPageWithBrowser(url: string, timeoutMs = 60000): Promise<{ title: string; text: string; error?: string }> {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    
    const response = await page.goto(url, { 
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    
    // Wait a bit for JS rendering
    await page.waitForTimeout(2000);
    
    const html = await page.content();
    const title = await page.title();
    
    // Extract text content using browser's DOM
    const text = await page.evaluate(() => {
      // Remove scripts and styles
      document.querySelectorAll("script, style, nav, footer, header, aside").forEach(el => el.remove());
      
      // Get text content
      let bodyText = document.body ? document.body.innerText || "" : "";
      
      // Clean up whitespace
      bodyText = bodyText.replace(/\n{3,}/g, "\n\n");
      bodyText = bodyText.replace(/[^\S\n]+/g, " ");
      
      return bodyText.trim();
    });
    
    if (!text || text.length < 20) {
      // Fallback: get innerText directly
      const fallbackText = await page.evaluate(() => document.body?.innerText || "");
      return { title: title || url, text: fallbackText.trim() };
    }
    
    return { title: title || url, text };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    return { title: url, text: "", error: errorMsg };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function fetchPage(url: string, useBrowser: boolean): Promise<{ title: string; text: string; error?: string }> {
  if (useBrowser) {
    // Use Playwright browser for JS-heavy sites
    return await fetchPageWithBrowser(url);
  }
  
  // Simple HTTP fetch for static pages
  try {
    const html = await httpGet(url, 60000);
    const title = extractTitle(html) || url;
    let text = htmlToClean(html);
    
    if (text.length < 50) {
      // Try less aggressive cleaning
      const text2 = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .trim();
      return { title, text: text2 };
    }
    
    return { title, text };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    return { title: url, text: "", error: errorMsg };
  }
}

async function llmExtract(content: string, prompt: string | null, schema: unknown | null): Promise<string> {
  const systemMsg = [
    "You are a data extraction assistant.",
    "Extract the requested information from the provided web page content.",
    "Be precise and only return the extracted data.",
    "Be as detailed as possible without including extra information.",
    "NEVER return an empty result.",
    "If you cannot find the requested data, you MUST explain why — e.g. the page didn't contain it, the content was blocked, the page was a login wall, etc.",
  ].join(" ");

  if (schema) {
    systemMsg += `\n\nReturn the data as JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
  }

  let userContent = content;
  if (prompt) {
    userContent += `\n\n---\nExtraction request: ${prompt}`;
  }

  const llmConfig = getModelInfo();
  if (!llmConfig) {
    throw new Error(
      "No LLM configuration found. Set LLM_URL and LLM_MODEL in .env, " +
      "or switch to a model in pi first."
    );
  }

  // Smart URL construction: add /v1 only if not already present
  const chatUrl = buildChatCompletionsUrl(llmConfig.url);
  
  const response = await httpPostJson(chatUrl, {
    model: llmConfig.model,
    messages: [
      { role: "system", content: systemMsg },
      { role: "user", content: userContent },
    ],
    temperature: 0.1,
  }, 600000); // 10 minutes timeout

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = response as any;
  const contentBlocks = data.choices?.[0]?.message?.content;
  
  if (!contentBlocks) {
    throw new Error("No content in LLM response");
  }
  
  return contentBlocks;
}

async function extractContent(
  urls: string[],
  prompt: string | null = null,
  schema: unknown | null = null,
  useBrowser: boolean = true,
): Promise<string> {
  if (!prompt && !schema) {
    const errorResult = { error: "At least one of prompt or schema is required." };
    logToolCall("extract", { urls }, JSON.stringify(errorResult));
    return JSON.stringify(errorResult, null, 2);
  }

  const contents: string[] = [];

  for (const url of urls) {
    const result = await fetchPage(url, useBrowser);
    
    if (result.error) {
      contents.push(`=== ${url} ===\nFailed to fetch: ${result.error}`);
    } else {
      let text = result.text;
      if (text.length > 12000) {
        text = text.slice(0, 12000) + "\n... [truncated]";
      }
      contents.push(`=== ${url} ===\n${result.title}\n\n${text}`);
    }
  }

  const combined = contents.join("\n\n");
  const result = await llmExtract(combined, prompt, schema);

  logToolCall("extract", {
    urls,
    prompt,
    schema,
    useBrowser,
  }, result);

  return result;
}

// ============================================================================
// Pi Extension
// ============================================================================

export default function piWebmcp(pi: ExtensionAPI): void {
  console.log("pi-webmcp: Loading web search and extraction tools");
  console.log(`  SEARCH_PROVIDER: ${SEARCH_PROVIDER}`);

  // Auto-detect the currently active model in pi
  pi.on("model_select", async (event, ctx) => {
    const modelId = event.model?.id ?? "";
    const providerName = event.model?.provider ?? "";

    if (!modelId) {
      console.warn("pi-webmcp: model_select fired but model.id is empty");
      return;
    }

    currentModelId = modelId;
    modelDetected = true;

    // Try to get baseUrl from the current model object first
    let baseUrl = "";
    if (ctx.model) {
      baseUrl = (ctx.model as any).baseUrl || "";
    }

    if (baseUrl) {
      console.log(
        `pi-webmcp: Model detected — ${providerName}/${modelId} → ${baseUrl}`
      );
      logConfigStatus();
    } else {
      // Try to find the model in the registry
      if (providerName && ctx.modelRegistry) {
        const foundModel = ctx.modelRegistry.find(providerName, modelId);
        if (foundModel) {
          baseUrl = (foundModel as any).baseUrl || "";
        }
      }

      if (baseUrl) {
        console.log(
          `pi-webmcp: Model found in registry — ${providerName}/${modelId} → ${baseUrl}`
        );
        logConfigStatus();
      } else {
        console.warn(
          `pi-webmcp: Model ${modelId} detected, but baseUrl is not available. ` +
          `Falling back to .env variables.`
        );
      }
    }
  });

  // Check if a model is already selected when the extension loads
  // (e.g., pi has already selected a model before this extension started)
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.model) return;

    const modelId = ctx.model.id ?? "";
    const providerName = ctx.model.provider ?? "";

    if (!modelId) return;

    currentModelId = modelId;
    modelDetected = true;

    // Try to get baseUrl from the current model object first
    let baseUrl = (ctx.model as any).baseUrl || "";

    if (baseUrl) {
      currentProviderBaseUrl = baseUrl;
      console.log(
        `pi-webmcp: Model already selected — ${providerName}/${modelId} → ${baseUrl}`
      );
      logConfigStatus();
    } else {
      // Try to find the model in the registry
      if (ctx.modelRegistry) {
        const foundModel = ctx.modelRegistry.find(providerName, modelId);
        if (foundModel) {
          baseUrl = (foundModel as any).baseUrl || "";
        }
      }

      if (baseUrl) {
        currentProviderBaseUrl = baseUrl;
        console.log(
          `pi-webmcp: Model found in registry — ${providerName}/${modelId} → ${baseUrl}`
        );
        logConfigStatus();
      } else {
        console.warn(
          `pi-webmcp: Model ${modelId} detected, but baseUrl is not available. ` +
          `Falling back to .env variables.`
        );
        logConfigStatus();
      }
    }
  });

  // Initial status log (will be updated by session_start or model_select)
  logConfigStatus();

  // Register get_current_date tool
  pi.registerTool({
    name: "get_current_date",
    label: "Current Date",
    description: "Get the current date in ISO format (YYYY-MM-DD) with day of week.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const now = new Date();
      const isoDate = now.toISOString().split("T")[0];
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const dayName = dayNames[now.getUTCDay()];
      return {
        content: [{ type: "text", text: `${isoDate} (${dayName})` }],
        details: {},
      };
    },
  });

  // Register search_web tool
  pi.registerTool({
    name: "search_web",
    label: "Web Search",
    description: "Search the web for a query. Returns titles, URLs, and descriptions of results. Supports DuckDuckGo (via duck-duck-scrape) and SearXNG.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 10)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const limit = params.limit || 10;
      const result = await searchWeb(params.query, limit);
      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  });

  // Register extract tool
  pi.registerTool({
    name: "extract",
    label: "Extract Content",
    description: "Extract structured data from one or more URLs. Fetches pages (with optional Playwright browser mode), extracts readable content, then sends to local LLM for structured extraction. Use search_web first to find URLs.",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), { description: "URLs to extract from" }),
      prompt: Type.Optional(Type.String({ description: "What data to extract from the page content" })),
      schema: Type.Optional(Type.Unknown({ description: "JSON schema for the output format" })),
      useBrowser: Type.Optional(Type.Boolean({ description: "Use Playwright browser for JS-heavy sites (default: true)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await extractContent(
        params.urls,
        params.prompt || null,
        params.schema || null,
        params.useBrowser !== false,
      );
      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  });
}
