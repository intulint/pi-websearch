# pi-websearch

Pi extension providing web search and structured content extraction tools.

## Installation

Install via `pi install`:

```bash
pi install github:user/pi-websearch
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

Pi loads `.ts` files via jiti without a build step, but `node_modules` must be present for runtime imports (e.g., `playwright`).

## Tools

### `search_web`

Search the web for a query. Returns titles, URLs, and snippet descriptions. Supports DuckDuckGo (HTML scraping) and SearXNG (JSON API).

```typescript
search_web({
  query: "latest AI news",
  limit: 5  // optional, default 10
})
```

Returns JSON array of search results:
```json
[
  {
    "title": "AI News Headline",
    "url": "https://example.com/ai-news",
    "description": "Description of the news article..."
  }
]
```

### `extract`

Extract structured data from one or more URLs. Fetches pages (with optional Playwright browser mode), extracts readable content, then sends to local LLM for structured extraction. Use `search_web` first to find URLs.

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

Get the current date.

```typescript
get_current_date()
// Returns: "2024-01-15 (Monday)"
```



## Configuration

Optionally create a `.env` file in the extension directory:

```env
# Explicit LLM model (overrides auto-detection from Pi)
LLM_URL=http://localhost:1234
LLM_MODEL=qwen3.5-27b

# Search provider: "ddg" (default) or "searxng"
SEARCH_PROVIDER=ddg

# SearXNG URL (required only if SEARCH_PROVIDER=searxng)
# SEARXNG_URL=http://localhost:8080
```

## Model Selection

The extension selects the LLM model using the following priority:

1. **Explicit model from `.env`** — if `.env` exists with `LLM_URL` and `LLM_MODEL`, these are used
2. **Auto-detected model from Pi** — if no `.env` file, the extension detects the currently active model in Pi and uses its configured LLM endpoint (from `~/.pi/agent/models.json`)

Auto-detection works by listening to Pi's `model_select` event and looking up the provider's `baseUrl` from the model registry. The LLM endpoint is constructed as `{baseUrl}/v1/chat/completions`.

## Dependencies

- `@sinclair/typebox` — Schema definitions for tool parameters
- `playwright` — Browser-based content extraction (JS-heavy sites)

> **Note:** `playwright` requires Chromium browser binaries. Run `npx playwright install chromium` after `npm install`.

## License

MIT
