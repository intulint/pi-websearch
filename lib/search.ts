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
  "Mozilla/5.0 (Windows NT 10.0; Win64; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
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
  return {
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

    return results;
  }

  // Should never reach here (loop always returns or throws)
  throw lastError ?? new Error("Search failed");
}
