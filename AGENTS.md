# pi-websearch — AGENTS.md

## What this is

A pi extension package providing three tools: `search_web`, `extract`, and `get_current_date`.
The extension auto-detects the active LLM model from Pi's model registry.
Optionally override LLM settings via `.env` file.

## Entry point and structure

- **Entry:** `pi-websearch.ts` (single file, no `src/` directory)
- **No build step.** Pi loads `.ts` via jiti. Never add a build step.
- **Test files:** `test-search.ts`, `test-search-regular.ts` — manual search tests

## Dependencies

Must be installed before running:

```bash
npm install
npx playwright install chromium
```

Runtime deps: `playwright`, `@sinclair/typebox`.
Peer deps (for type stubs): `@mariozechner/pi-coding-agent`, `@sinclair/typebox`.

## Configuration

Create a `.env` file to override defaults:

```env
LLM_URL=http://localhost:1234
LLM_MODEL=qwen3.5-27b
SEARCH_PROVIDER=ddg        # or "searxng"
SEARXNG_URL=http://localhost:8080
```

- `LLM_URL` + `LLM_MODEL` — explicit model (overrides auto-detection)
- `SEARCH_PROVIDER` — `ddg` (DuckDuckGo, default) or `searxng`
- `SEARXNG_URL` — required only if using SearXNG

If no `.env` exists, the extension auto-detects the active Pi model from the model registry.

## Tools

### `search_web`

Search the web. Returns JSON array of `{ title, url, description }`.

### `extract`

Fetch URLs (with optional Playwright browser mode), extract readable content, send to local LLM for structured extraction.

### `get_current_date`

Returns human-readable date string.

## Important gotchas

- **No `dist/` directory.** Everything is raw TypeScript loaded by jiti.
- **`node_modules` must exist.** Pi does not auto-run `npm install` for local extensions.
- **Type stubs:** Minimal types are provided via `@mariozechner/pi-coding-agent` peer dependency for `tsc --noEmit` without the full monorepo.
- **Tool call logging:** All tool calls are logged to `tool_calls.log.json` in the project root.
- **Playwright browser:** Requires `chromium` binary installed via `npx playwright install chromium`.

## Style

- No `any` types unless absolutely necessary.
- Dynamic imports (`await import()`) are used for Node.js stdlib modules.
- Follow patterns in `pi-websearch.ts` for tool registration and event handling.

## Related docs

- `ARCHITECTURE.md` — Detailed architecture overview
- `INSIGHTS.md` — Development insights and lessons learned
- `docs/extensions.md` — Pi extension API reference
