/**
 * DuckDuckGo web search — HTTP helpers + scraping logic.
 */

import { httpGetRaw } from "./http.js";

// ============================================================================
// Constants
// ============================================================================

const DDG_TIMEOUT_MS = 15_000;
const DDG_EXCLUDE_SITES = "-site:grokipedia.com";

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

export async function searchDdg(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const ddgQuery = query.trim();
  if (!ddgQuery) throw new Error("Search query cannot be empty");

  const fullQuery = `${ddgQuery} ${DDG_EXCLUDE_SITES}`;
  const url = buildSearchUrl(fullQuery);
  const headers = buildHeaders();

  const { status, decompressedBody: html } = await httpGetRaw(url, {
    headers,
    timeoutMs: DDG_TIMEOUT_MS,
  });

  if (status !== 200) {
    throw new Error(`HTTP ${status}: Failed to fetch search results`);
  }

  if (html.includes("challenge-form")) {
    throw new Error(
      "DuckDuckGo detected an anomaly in the request. Please try again later.",
    );
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

  return results;
}
