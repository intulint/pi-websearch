# pi-websearch — AGENTS.md

## What this is

A pi extension package providing three tools: `search_web`, `extract`, and `get_current_date`.
The extension auto-detects the active LLM model from Pi's model registry.
Optionally override LLM settings via `.env` file — when `.env` exists, the `extract` tool **uses the .env model for the LLM call, then restores the original Pi model** after completion.

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

## .env behavior

When `LLM_URL` and `LLM_MODEL` are set in `.env`, the extension:

1. At `session_start` — registers/overwrites provider `env-overridden` with `pi.registerProvider()` (`openai-completions` API)
2. At `session_shutdown` — resets `envProviderRegistered` flag so the provider is re-registered on next `session_start` (handles `.env` changes)
3. When `extract` tool is called:
   - Captures the current Pi model from `_ctx.model` (provider, id, registry entry)
   - **Always** switches to the `.env` model via `pi.setModel()` (if `.env` is configured)
   - Executes the LLM call — `resolveModel()` prefers `.env` config over auto-detected
   - **Always** restores the original Pi model via `pi.setModel()` in `finally` block (even on error)
4. If no `.env` is set — `extract` uses the auto-detected Pi model, no switching occurs

Model switching is unconditional when `.env` is configured — it does **not** depend on `originalProvider`/`originalId` being present.

The model ID in `.env` is sanitized (slashes/colons → dashes) because Pi model IDs don't support those characters. The original `.env` model name is kept as the display `name`.

To manually switch model: use `/model` in Pi or change `.env` and reload.

## Model resolution flow

```
resolveModel()
    │
    ├─ Priority 1: .env (LLM_URL + LLM_MODEL)
    │   └─ Always checked first, always wins when both are set
    │
    └─ Priority 2: auto-detected from Pi
        ├─ ctx.model.id → detectedModelId
        ├─ ctx.model.baseUrl → detectedBaseUrl
        └─ fallback: ctx.modelRegistry.find(provider, modelId)
```

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
