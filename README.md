# pi-webmcp

Pure TypeScript extension for Pi coding agent — brings web search and content extraction capabilities.

## Features

- **`search_web(query, limit)`** — Search the web using DuckDuckGo with browser-like headers (mimics real Chrome/Edge/Firefox/Safari to avoid bot detection)
- **`extract(urls, prompt, schema, useBrowser)`** — Extract structured data from URLs using the currently active LLM
- **`get_current_date()`** — Get the current date

## Installation

1. Copy this extension to your Pi extensions directory:

```bash
cp -r pi-webmcp ~/.pi/agent/extensions/pi-webmcp
```

2. (Optional) Configure an explicit LLM model — create `.env` in the extension directory:

```env
# Explicit LLM model (overrides auto-detection from Pi)
LLM_URL=http://localhost:1234
LLM_MODEL=your-model-name

# Search provider: "ddg" (default) or "searxng"
SEARCH_PROVIDER=ddg

# SearXNG URL (required only if SEARCH_PROVIDER=searxng)
# SEARXNG_URL=http://localhost:8080
```

3. Reload Pi extensions:

```
/reload
```

## Model Selection

The extension selects the LLM model using the following priority:

1. **Explicit model from `.env`** — if `.env` file exists with `LLM_URL` and `LLM_MODEL`, these are used
2. **Auto-detected model from Pi** — if no `.env` file, the extension detects the currently active model in Pi and uses its configured LLM endpoint (from `~/.pi/agent/models.json`)

**How auto-detection works:**
- Listens to Pi's `model_select` event to track model changes
- Looks up the provider's `baseUrl` from the model registry
- Constructs the LLM endpoint as `{baseUrl}/v1/chat/completions`
- Uses the model's `id` as the model parameter in API requests

## Tools

### search_web

Search the web for a query. Uses DuckDuckGo HTML version with browser-like headers (random user-agent rotation, proper Sec-Fetch headers, sec-ch-ua headers) to mimic a real browser and avoid bot detection.

```typescript
search_web({
  query: "latest AI news",
  limit: 5  // optional, default 10
})
```

Returns:
```json
[
  {
    "title": "AI News Headline",
    "url": "https://example.com/ai-news",
    "description": "Description of the news article..."
  }
]
```

### extract

Extract structured data from one or more URLs.

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

### get_current_date

Get the current date.

```typescript
get_current_date()
// Returns: "2024-01-15 (Monday)"
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_URL` | No | Explicit LLM endpoint (e.g., `http://localhost:1234`). Overrides auto-detection if `.env` exists |
| `LLM_MODEL` | No | Explicit model name (e.g., `qwen3.5-27b`). Overrides auto-detection if `.env` exists |
| `SEARCH_PROVIDER` | No | Search provider: `ddg` (default) or `searxng` |
| `SEARXNG_URL` | Conditional | SearXNG instance URL (required if `SEARCH_PROVIDER=searxng`) |

## Differences from webmcp

This is a pure TypeScript reimplementation of the webmcp Python project, adapted for Pi:

| Feature | webmcp (Python) | pi-webmcp (TypeScript) |
|---------|-----------------|------------------------|
| Web Search | `ddgs` Python package | DuckDuckGo HTML with browser headers (Chrome/Edge/Firefox/Safari UA rotation) |
| Content Extraction | Playwright browser | HTTP fetch + Playwright browser mode |
| LLM Integration | MCP protocol | Direct HTTP calls (auto-detected or explicit model) |
| Dependencies | Python packages | Node.js stdlib + typebox + playwright |

## License

MIT

## Pi Documentation

- [Extensions](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/extensions.md) — How Pi extensions work
- [Packages](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/packages.md) — How to create Pi packages
- [SDK](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/sdk.md) — Pi SDK reference
