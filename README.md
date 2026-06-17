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

Extract structured data from one or more URLs. Fetches pages (with optional Playwright browser mode), extracts readable content, then sends to an LLM for structured extraction. Uses either the model specified in `.env` or the currently selected Pi model. Use `search_web` first to find URLs.

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
2. **Auto-detected model from Pi** — if no `.env`, the extension uses the currently active model in Pi.

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

## License

MIT
