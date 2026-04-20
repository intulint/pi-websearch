# Insights & Research Experience — DuckDuckGo Search

## Problem Statement

Implement reliable web search for Pi coding agent using DuckDuckGo, avoiding bot detection while extracting structured results (title, URL, description).

## What Didn't Work

### 1. `duck-duck-scrape` npm package
```typescript
import DDG from "duck-duck-scrape";
DDG.search("query");
```
**Result:** `DDG detected an anomaly in the request, you are likely making requests too quickly.`
- Package is outdated, uses old API endpoints
- DuckDuckGo blocks the package's user-agent pattern
- No way to customize headers or bypass detection

### 2. Playwright `headless: true`
```typescript
chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
```
**Result:** 273-byte error page: `If this persists, please email us.`
- DuckDuckGo's HTML version (`html.duckduckgo.com`) detects headless Chromium
- Even with `--disable-blink-features=AutomationControlled` and navigator overrides, the bot detection triggers
- The error page is returned instead of search results
- **Key insight:** DuckDuckGo's HTML version is heavily anti-bot protected for headless browsers

### 3. Playwright `headless: false` (headed mode)
```typescript
chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
```
**Result:** Works locally with X server, but fails on headless servers
- Error: `Looks like you launched a headed browser without having a XServer running`
- On CI/headless servers: `Missing X server or $DISPLAY`
- **Key insight:** `headless: false` successfully bypasses bot detection but requires a display server
- Could work with `xvfb-run` but adds complexity and dependencies

### 4. Incorrect HTML parsing regex
```typescript
/<div class="result[^"]*"[^>]*>[\s\S]*?<\/div>/g
```
**Result:** Empty descriptions, partial results
- The regex stops at the **first** `</div>` which is the inner `result__body` div, not the outer result div
- The snippet text (`<a class="result__snippet">`) is inside the inner div, so it's never captured
- **Key insight:** HTML parsing with simple regex is fragile — need to account for nested div structure

## What Worked

### HTTPS GET with Browser-Like Headers

```typescript
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
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
```

**Why it works:**
- DuckDuckGo's HTML version checks for browser-like headers, not just User-Agent
- `Sec-Fetch-*` headers and `sec-ch-ua` headers are critical — these are sent by real browsers
- Without these headers, the request looks like a simple HTTP client (curl, wget, python requests)
- Random user-agent rotation (Chrome, Edge, Firefox, Safari, Linux) helps avoid pattern detection
- **Key insight:** Bot detection is header-based, not just User-Agent based

### Correct HTML Parsing Regex

```typescript
/<div class="result[^"]*results_links[^"]*"[^>]*>[\s\S]*?(?=<div class="result[^"]*results_links|$)/g
```

**Why it works:**
- Uses lookahead `(?=<div class="result...|$)` instead of `</div>` to capture the full outer div
- Matches until the next result div or end of content
- The `results_links` class ensures we match only search results (not ads or related searches)
- **Key insight:** For nested HTML structures, lookahead is more reliable than greedy/non-greedy `</div>` matching

### Extracted Fields

```typescript
// Title: from h2.result__title > a.result__a
/<h2[^>]*>[\s\S]*?<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/

// URL: from result__a anchor, decoded from uddg= redirect
/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"/

// Description: from a.result__snippet
/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i
```

**Key findings:**
- DuckDuckGo uses redirect URLs: `//duckduckgo.com/l/?uddg=actual_url&rut=hash`
- Must decode `uddg=` parameter to get the actual URL
- Snippet text may contain `<b>` tags for highlighted keywords — strip them
- Descriptions are extracted from `a.result__snippet` which is a child of `result__body`

## Architecture Decisions

### Why not Playwright for search?
- Playwright works for **fetching pages** (used in `fetchPageWithBrowser`)
- Playwright does NOT work for **searching** on DuckDuckGo HTML version
- The HTML version is specifically protected against headless browsers
- Regular browser mode requires X server which isn't available on headless servers

### Why not DDGS Python library?
- The Python `ddgs` library uses internal API endpoints
- These endpoints are blocked when accessed from Node.js
- The library is not designed for headless server environments

### Why HTTPS GET with headers?
- DuckDuckGo's HTML version (`html.duckduckgo.com`) serves static HTML
- No JavaScript rendering required
- Headers are the only anti-bot measure
- Simple HTTP client can replicate browser behavior with proper headers
- No external dependencies beyond Node.js stdlib

## Retry Strategy

```typescript
async function retry<T>(fn, { maxAttempts = 5, minTimeout = 2000, multiplier = 2 }) {
  // Exponential backoff with jitter
  const timeout = Math.min(minTimeout * Math.pow(multiplier, attempts - 1), 60000) * (1 - Math.random() * 0.5);
}
```

- Max 5 attempts with exponential backoff (2s, 4s, 8s, 16s, 32s)
- Jitter (50-100%) to avoid thundering herd
- No-results errors are not retried
- Timeout is capped at 60 seconds

## Testing Results

### Successful queries:
- English: `"test duckduckgo search"` → 5 results with descriptions
- Russian: `"как работает квантовый компьютер"` → 3 results with descriptions
- Mixed: `"machine learning latest news 2026"` → 5 results with descriptions

### Error handling:
- Bot detection: `DuckDuckGo detected an anomaly in the request. Please try again later.`
- Timeout: `Request timeout`
- HTTP errors: `HTTP 4xx/5xx`
- No results: Returns empty array `[]`

## Sibling Project Reference (webmcp)

The sibling Python project `../webmcp` uses:
- `ddgs.text()` for search (Python library)
- Playwright for page fetching (not search)
- The Python library makes direct API calls to DuckDuckGo's internal endpoints

For TypeScript, we replicate the browser-like header approach since the Python library doesn't work from Node.js.

## Key Takeaways

1. **Bot detection is header-based** — User-Agent alone is not enough; need full browser header set
2. **Headless browsers are detected** — `headless: true` in Playwright triggers anti-bot measures
3. **HTML parsing requires lookahead** — Simple `</div>` matching fails with nested structures
4. **Redirect URL decoding is necessary** — DuckDuckGo uses `uddg=` parameter for actual URLs
5. **Retry with backoff is essential** — Transient errors (bot detection triggers) should be retried
6. **User-agent rotation helps** — Randomly selecting from multiple desktop UAs reduces pattern detection
7. **No external search libraries work reliably** — `duck-duck-scrape` is blocked; custom HTTP approach is best
