/**
 * Test script for regular DuckDuckGo search using browser-like headers
 * Uses HTTPS GET with full browser headers to mimic a real browser — avoids bot detection
 * Based on the reference from ../webmcp (browser masking approach)
 * Usage: npx tsx test-search-regular.ts "search query" [limit]
 */

import https from "node:https";
import zlib from "node:zlib";
import { URL } from "node:url";

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

// Desktop user agents for browser impersonation
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
] as const;

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildHeaders(): Record<string, string> {
  return {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Sec-GPC': '1',
    'Cache-Control': 'max-age=0',
    'sec-ch-ua': '"Chromium";v="146", "Not=A?Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

function decodeDdgUrl(href: string): string {
  if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
    return decodeURIComponent(href.split('uddg=')[1].split('&')[0]);
  } else if (href.startsWith('//')) {
    return 'https:' + href;
  }
  return href;
}

function parseResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  
  // Match result blocks - capture full div including inner content
  const resultPattern = /<div class="result[^"]*results_links[^"]*"[^>]*>[\s\S]*?(?=<div class="result[^"]*results_links|$)/g;
  const resultMatches = html.match(resultPattern);
  
  if (resultMatches) {
    for (const match of resultMatches) {
      if (results.length >= limit) break;
      
      // Extract title from h2.result__title > a.result__a
      const titleMatch = match.match(/<h2[^>]*>[\s\S]*?<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      
      if (!title) continue;
      
      // Extract URL from result__a anchor
      const urlMatch = match.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"/);
      let url = '';
      if (urlMatch) {
        url = decodeDdgUrl(urlMatch[1]);
      }
      
      if (!url) continue;
      
      // Extract description from a.result__snippet
      const snippetMatch = match.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      const description = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
      
      results.push({ title, url, description });
    }
  }
  
  return results.slice(0, limit);
}

async function searchDdgBrowser(query: string, limit: number = 5): Promise<SearchResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}&b=0&p=1&s=0&df=y`;
  
  const headers = buildHeaders();
  
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf-8');
        
        // Decode compressed content
        if (res.headers['content-encoding'] === 'gzip') {
          html = zlib.gunzipSync(Buffer.concat(chunks)).toString('utf-8');
        } else if (res.headers['content-encoding'] === 'br') {
          html = zlib.brotliDecompressSync(Buffer.concat(chunks)).toString('utf-8');
        }
        
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: Failed to fetch search results`));
          return;
        }
        
        // Check for challenge page (bot detection)
        if (html.includes('challenge-form')) {
          reject(new Error('DuckDuckGo detected bot activity — please try again later'));
          return;
        }
        
        // Check for no results
        if (html.includes('no-results')) {
          resolve([]);
          return;
        }
        
        const results = parseResults(html, limit);
        resolve(results);
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// Retry helper with exponential backoff and jitter
async function retry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; minTimeout?: number; multiplier?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const { maxAttempts = 5, minTimeout = 2000, multiplier = 2, signal } = options;
  let attempts = 0;
  
  while (true) {
    signal?.throwIfAborted();
    
    try {
      return await fn();
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) {
        throw error;
      }
      
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("no-results") || msg.includes("No Results")) {
        throw error;
      }
      
      // Exponential backoff with jitter
      const timeout = Math.min(
        minTimeout * Math.pow(multiplier, attempts - 1),
        60000,
      ) * (1 - Math.random() * 0.5);
      
      console.error(`  ⏳ Attempt ${attempts} failed: ${msg}. Retrying in ${(timeout / 1000).toFixed(1)}s...`);
      await new Promise(resolve => setTimeout(resolve, timeout));
    }
  }
}

// Main
async function main() {
  const query = process.argv[2] || "последние новости AI";
  const limit = parseInt(process.argv[3] || "5");
  
  console.log(`\n🔍 Searching for: "${query}"`);
  console.log(`📊 Limit: ${limit}\n`);
  
  try {
    const results = await retry(() => searchDdgBrowser(query, limit));
    console.log(`✅ Found ${results.length} results:\n`);
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
