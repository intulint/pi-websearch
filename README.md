# pi-websearch

<div align="center">

**[🇬🇧 English](README.md) · [🇷🇺 Русский](README.ru.md)**

</div>

---

**pi-websearch** — a lightweight Pi extension for web search and structured content extraction. No build step, uses `playwright` and `typebox`, and requires `@mariozechner/pi-coding-agent` + `@mariozechner/pi-tui` as peer dependencies. Drop it in and it works.

## Installation

Install via `pi install`:

```bash
pi install https://github.com/intulint/pi-websearch
```

Or install from a local path:

```bash
pi install ./path/to/pi-websearch
```

### Prerequisites (local development)

If running the extension directly from the project directory (without `pi install`), install dependencies first:

```bash
npm install
npx playwright install chromium
```

Pi loads `.ts` files via jiti without a build step, but `node_modules` must be present for runtime imports (e.g., `playwright`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui` peer dependencies).

## Tools

### `search_web`

Search the web for a query using DuckDuckGo HTML scraping. Returns a JSON string array of `{ title, url, description }`.

> **WARNING:** Do NOT call this tool multiple times in a row — rate limits apply. Wait between calls.

```typescript
search_web({
  query: "latest AI news",
  limit: 5  // optional, default 10
})
```

Returns JSON string:
```json
[{
  "title": "AI News Headline",
  "url": "https://example.com/ai-news",
  "description": "Description of the news article..."
}]
```

### `extract`

Extract structured data from one or more URLs. Fetches pages (with optional Playwright browser mode), extracts readable content, then sends to local LLM for structured extraction. Use `search_web` first to find URLs.

> **WARNING:** Only one `extract` call is allowed per batch. If multiple extract calls are sent in the same request, only the first one will execute — the rest will return an error immediately.

```typescript
extract({
  urls: ["https://example.com/page1", "https://example.com/page2"],
  prompt: "Extract all product prices and names",
  schema: {
    type: "object",
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "number" }
          }
        }
      }
    }
  },
  useBrowser: true  // optional, default true
})
```

Note: The `schema` parameter can be `null` or `Type.Unknown()` for flexible extraction.

### `get_current_date`

Get the current date in ISO format with day of week.

```typescript
get_current_date()
// Returns: "2024-01-15 (Monday)"
```

## Configuration

Optionally create a `.env` file in the extension directory to override the LLM model:

```env
# Explicit LLM model (overrides auto-detection from Pi)
LLM_URL=http://localhost:1234
LLM_MODEL=qwen3.5-27b
LLM_API_KEY=your-api-key-here  # optional, for authenticated endpoints
```


| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_URL` | No | - | Explicit LLM endpoint (overrides auto-detection) |
| `LLM_MODEL` | No | - | Explicit model name (overrides auto-detection) |
| `LLM_API_KEY` | No | - | API key for authenticated endpoints |

## Proxy Configuration

The extension respects `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables:

- **`search_web` (DuckDuckGo):** Direct connection to `duckduckgo.com` (proxy bypass)
  - DuckDuckGo blocks requests through the configured proxy IP (202 Challenge)
  - Uses direct `Agent` connection, not `ProxyAgent`

- **`extract` (Playwright):** Uses proxy with `NO_PROXY` bypass
  - Proxy configured via `proxy` option in Playwright
  - Respects `NO_PROXY` environment variable

- **`extract` (HTTP fallback):** Uses proxy for simple pages
  - HTTP GET requests respect `HTTP_PROXY`/`HTTPS_PROXY`
  - Uses `undici` with `ProxyAgent`

## Model Selection

The extension selects the LLM model using the following priority:

1. **Explicit model from `.env`** — if `.env` exists with `LLM_URL` and `LLM_MODEL`, these are used for the `extract` tool's LLM calls.
2. **Auto-detected model from Pi** — if no `.env`, the extension uses the currently active model in Pi..

The LLM endpoint is constructed as `{baseUrl}/v1/chat/completions`. If an API key is available (from `.env` or Pi's model registry), it's sent as a Bearer token in the `Authorization` header.

### Extract tool model behavior

The `extract` tool uses the configured model for the LLM call, then **restores the original Pi model** after completion:

- With `.env`: switches to `.env` model → LLM call → restores original Pi model
- Without `.env`: no switch, uses auto-detected Pi model directly
- Restoration always happens in a `finally` block — even on error, the Pi model is restored

## Batch Restrictions

- **`extract`**: Only one `extract` call is allowed per batch. If the agent sends multiple `extract` calls in a single request, only the first one executes — others return an error immediately instead of hanging until timeout.
- The batch flag resets on each new user message (`turn_start` event).

## Dependencies

Runtime (in `package.json`):
- `typebox` — Schema definitions for tool parameters
- `playwright` — Browser-based content extraction (JS-heavy sites)

Peer:
- `@mariozechner/pi-coding-agent` — Pi extension API
- `@mariozechner/pi-tui` — Pi TUI components (Text, etc.)

Transitive (via undici in node_modules):
- `undici` — HTTP client with proxy support
- `node:zlib` — Decompression (gzip, br, deflate)

> **Note:** `playwright` requires Chromium browser binaries. Run `npx playwright install chromium` after `npm install`.

## Important Gotchas

- **No `dist/` directory.** Everything is raw TypeScript loaded by jiti.
- **`node_modules` must exist.** Pi does not auto-run `npm install` for local extensions.
- **Type stubs:** Minimal types are provided via `@mariozechner/pi-coding-agent` peer dependency for `tsc --noEmit` without the full monorepo.
- **Tool call logging:** All tool calls are logged to `~/.pi/logs/pi-websearch/tool_calls.log.json` (in user home directory).
- **Playwright browser:** Requires `chromium` binary installed via `npx playwright install chromium`.
- **Static stdlib imports:** Node.js stdlib modules (e.g., `fs`, `path`, `zlib`) are imported statically via `import { ... } from "node:..."`.
- **Dynamic imports:** Playwright is loaded dynamically at runtime, not statically imported.
- **Jiti mapping:** Jiti handles the `.js` extension mapping for imports.
- **Lazy .env reload:** `.env` is read lazily at session start. Changes to `.env` survive `/reload` without restarting Pi.
- **API response formats:** Some LLM APIs wrap responses differently. Code handles common formats automatically.

## Implementation Details

### Timeouts

- **DuckDuckGo search:** 15 seconds (retry 2 times with jitter)
- **Page fetch (HTTP):** 60 seconds
- **Page fetch (Playwright):** 60 seconds
- **LLM extraction:** 10 minutes
- **Playwright general timeout:** 90 seconds

### Retry Logic

- DuckDuckGo search: 2 retries with exponential backoff + jitter
- Base delay: 2 seconds, jitter: 50% of base

### Content Processing

- Maximum content characters per URL: 12,000
- Minimum text length before fallback: 50 characters
- HTML cleaning: removes `<script>`, `<style>`, tags, normalizes whitespace

### API Response Handling

- Common LLM API response formats are handled automatically
- Code detects and normalizes different response structures

### User-Agent Rotation

- 5 different User-Agents (Chrome, Edge, Firefox, Safari, Linux)
- Randomly selected to avoid bot detection patterns


## License

MIT
