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

Runtime deps: `playwright`, `typebox`.
Peer deps (for type stubs): `@mariozechner/pi-coding-agent`.

## Configuration

Create a `.env` file to override defaults:

```env
LLM_URL=http://localhost:1234
LLM_MODEL=qwen3.5-27b
```

- `LLM_URL` + `LLM_MODEL` — explicit model (overrides auto-detection)

If no `.env` exists, the extension auto-detects the active Pi model.

## Tools

### `search_web`

Search the web using DuckDuckGo HTML scraping. Returns JSON array of `{ title, url, description }`.

> **WARNING:** Do NOT call this tool multiple times in a row — rate limits apply. Wait between calls.

### `extract`

Fetch URLs (with optional Playwright browser mode), extract readable content, send to local LLM for structured extraction.

> **WARNING:** Only one `extract` call is allowed per batch. If multiple extract calls are sent in the same request, only the first one executes — others return an error immediately.

### `get_current_date`

Returns human-readable date string.

## Important gotchas

- **No `dist/` directory.** Everything is raw TypeScript loaded by jiti.
- **`node_modules` must exist.** Pi does not auto-run `npm install` for local extensions.
- **Type stubs:** Minimal types are provided via `@mariozechner/pi-coding-agent` peer dependency for `tsc --noEmit` without the full monorepo.
- **Tool call logging:** All tool calls are logged to `tool_calls.log.json` in the project root.
- **Playwright browser:** Requires `chromium` binary installed via `npx playwright install chromium`.
- **Batch restriction:** Multiple `extract` calls in the same batch are blocked — only the first one executes.

## Style

- No `any` types unless absolutely necessary.
- Dynamic imports (`await import()`) are used for Node.js stdlib modules.
- Follow patterns in `pi-websearch.ts` for tool registration and event handling.

## Related docs

- `ARCHITECTURE.md` — Detailed architecture overview
- `EVENTS.md` — Pi events used by the extension
- `INSIGHTS.md` — Development insights and lessons learned
