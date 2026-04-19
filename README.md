# pi-webmcp

Pure TypeScript extension for Pi coding agent — brings web search and content extraction capabilities.

## Features

- **`search_web(query, limit)`** — Search the web using DuckDuckGo (default) or SearXNG
- **`extract(urls, prompt, schema, useBrowser)`** — Extract structured data from URLs using the currently active LLM
- **`get_current_date()`** — Get the current date

## Installation

1. Copy this extension to your Pi extensions directory:

```bash
cp -r pi-webmcp ~/.pi/agent/extensions/pi-webmcp
```

2. Optionally configure search provider (create `.env` in the extension directory):

```env
# Search provider: "ddg" (default) or "searxng"
SEARCH_PROVIDER=ddg

# SearXNG URL (required only if SEARCH_PROVIDER=searxng)
# SEARXNG_URL=http://localhost:8080

# Fallback LLM config (used if auto-detection fails)
LLM_URL=http://localhost:1234
LLM_MODEL=your-model-name
```

3. Reload Pi extensions:

```
/reload
```

## Auto-detection

The extension automatically detects the currently active model in pi and uses its configured LLM endpoint (from `~/.pi/agent/models.json`).

**How it works:**
- Listens to pi's `model_select` event to track model changes
- Looks up the provider's `baseUrl` from the model registry
- Constructs the LLM endpoint as `{baseUrl}/v1/chat/completions`
- Uses the model's `id` as the model parameter in API requests

**Fallback:** If auto-detection fails (e.g., no model selected yet), falls back to `LLM_URL` and `LLM_MODEL` from `.env`.

## Tools

### search_web

Search the web for a query.

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
| `LLM_URL` | No (fallback) | Local LLM endpoint (e.g., `http://localhost:1234`) |
| `LLM_MODEL` | No (fallback) | Model name (e.g., `qwen3.5-27b`) |
| `SEARCH_PROVIDER` | No | Search provider: `ddg` (default) or `searxng` |
| `SEARXNG_URL` | Conditional | SearXNG instance URL (required if `SEARCH_PROVIDER=searxng`) |

## Differences from webmcp

This is a pure TypeScript reimplementation of the webmcp Python project, adapted for Pi:

| Feature | webmcp (Python) | pi-webmcp (TypeScript) |
|---------|-----------------|------------------------|
| Web Search | `ddgs` Python package | DuckDuckGo HTML scraping |
| Content Extraction | Playwright browser | HTTP fetch (browser mode falls back) |
| LLM Integration | MCP protocol | Direct HTTP calls (auto-detected model) |
| Dependencies | Python packages | Node.js stdlib + typebox |

## License

MIT
