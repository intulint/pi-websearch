/**
 * DuckDuckGo web search — HTTP helpers + scraping logic.
 */

import { httpGetRaw } from "./http.js";

// ============================================================================
// Constants
// ============================================================================

const DDG_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2_000;

const USER_AGENTS = [
  // Firefox stable 160 (10 Nov 2026) — основной, DDG лучше реагирует
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:160.0) Gecko/20100101 Firefox/160.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:160.0) Gecko/20100101 Firefox/160.0",
  // Chrome stable 157 (3 Nov 2026) — fallback
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  // Safari 26.6 — fallback
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15",
];

// ============================================================================
// Types
// ============================================================================

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

// ============================================================================
// Helpers
// ============================================================================

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildSearchUrl(query: string): string {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&b=0&p=1&s=0&df=y`;
}

function decodeDdgUrl(href: string): string {
  if (href.startsWith("//duckduckgo.com/l/?uddg=")) {
    return decodeURIComponent(href.split("uddg=")[1].split("&")[0]);
  }
  if (href.startsWith("//")) return "https:" + href;
  return href;
}

function buildHeaders(): Record<string, string> {
  const ua = getRandomUserAgent();
  const isChrome = ua.includes("Chrome/") && !ua.includes("Edg/") && !ua.includes("OPR/");

  const headers: Record<string, string> = {
    "User-Agent": ua,
    // Как в браузере — без image/avif/webp, приоритет document
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    // ru-RU приоритет — как в браузере
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    Connection: "keep-alive",
    DNT: "1",
    Priority: "u=0, i",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-GPC": "1",
  };

  // sec-ch-ua только для Chrome/Edge (Firefox не шлёт)
  if (isChrome || ua.includes("Edg/")) {
    headers["sec-ch-ua"] = '"Not_A Brand";v="8", "Chromium";v="157", "Google Chrome";v="157"';
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = '"Windows"';
    // Примечание: Chrome на macOS/Linux отправляет "macOS" / "Linux"
    // Для простоты — всегда "Windows" (доминирующая платформа, DDG не проверяет строгую консистентность)
  }

  return headers;
}

// ============================================================================
// DuckDuckGo scraping
// ============================================================================

function isTransientError(status: number, html: string): boolean {
  if (status === 202 || status === 429 || status >= 500) return true;
  if (html.includes("challenge-form")) return true;
  return false;
}

async function delayWithJitter(baseMs: number): Promise<void> {
  const jitter = Math.random() * baseMs * 0.5;
  await new Promise((resolve) => setTimeout(resolve, baseMs + jitter));
}

// ============================================================================
// Result parsing (pure — unit-testable)
// ============================================================================

export function parseResults(html: string, limit: number): SearchResult[] {
  const resultBlocks = html.match(
    /<div class="result[^"]*results_links[^"]*"[^>]*>[\s\S]*?(?=<div class="result[^"]*results_links|$)/g,
  );
  if (!resultBlocks) return [];

  const results: SearchResult[] = [];
  for (let i = 0; i < Math.min(limit, resultBlocks.length); i++) {
    const parsed = parseResultBlock(resultBlocks[i]);
    if (parsed) results.push(parsed);
  }
  return results;
}

function parseResultBlock(block: string): SearchResult | null {
  const titleMatch = block.match(
    /<h2[^>]*>[\s\S]*?<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/,
  );
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    : "";
  if (!title) return null;

  const urlMatch = block.match(
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"/,
  );
  const searchUrl = urlMatch ? decodeDdgUrl(urlMatch[1]) : "";
  if (!searchUrl) return null;

  const snippetMatch = block.match(
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
  );
  const description = snippetMatch
    ? snippetMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    : "";

  return { title, url: searchUrl, description };
}

// ============================================================================
// DuckDuckGo search
// ============================================================================

export async function searchDdg(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const ddgQuery = query.trim();
  if (!ddgQuery) throw new Error("Search query cannot be empty");

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Search aborted");

    const url = buildSearchUrl(ddgQuery);
    const headers = buildHeaders();

    let status: number;
    let html: string;

    try {
      const response = await httpGetRaw(url, {
        headers,
        timeoutMs: DDG_TIMEOUT_MS,
        signal,
      });
      status = response.status;
      html = response.decompressedBody;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_RETRIES) {
        await delayWithJitter(RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    if (status !== 200) {
      const msg = `HTTP ${status}: Failed to fetch search results`;
      if (attempt < MAX_RETRIES && isTransientError(status, html)) {
        lastError = new Error(msg);
        await delayWithJitter(RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw new Error(msg);
    }

    if (html.includes("challenge-form")) {
      const msg = "DuckDuckGo detected an anomaly in the request. Please try again later.";
      if (attempt < MAX_RETRIES) {
        lastError = new Error(msg);
        await delayWithJitter(RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw new Error(msg);
    }

    // Successful response — parse results
    return parseResults(html, limit);
  }

  // Should never reach here (loop always returns or throws)
  throw lastError ?? new Error("Search failed");
}
