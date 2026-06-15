# Pi Events Used by pi-websearch

This file documents the Pi events that the extension subscribes to and how they are used.

## Events

### `session_start`

**When fires:** When a new session starts.

**Used for:** Auto-detect the currently selected LLM model and its base URL.

**Handler:**
```typescript
pi.on("session_start", async (_event, ctx) => {
  // Extract modelId and provider from ctx.model
  // Look up baseUrl from ctx.model or ctx.modelRegistry
  // Set currentModelId and currentProviderBaseUrl
  // Log config status
});
```

**Priority:** High — ensures the extension has model info before any tool calls.

---

### `model_select`

**When fires:** When the user switches to a different model in Pi.

**Used for:** Update the active LLM configuration when the model changes.

**Handler:**
```typescript
pi.on("model_select", async (event, ctx) => {
  // Extract modelId and provider from event.model
  // Look up baseUrl from ctx.model or ctx.modelRegistry
  // Update currentModelId and currentProviderBaseUrl
  // Log config status
});
```

**Priority:** High — ensures the extension always uses the currently selected model.

---

### `session_shutdown`

**When fires:** When a session is closing (exit, /reload, /new, /fork, /clone).

**Used for:** Reset `envProviderRegistered` flag so the env provider is re-registered on the next `session_start` (handles `.env` file changes).

**Handler:**
```typescript
pi.on("session_shutdown", () => {
  envProviderRegistered = false;
});
```

**Priority:** Low — ensures `.env` changes are picked up after reload.

---

### `turn_start`

**When fires:** At the start of each new user message (turn).

**Used for:** Reset the `extractAllowed` batch tracking flag.

**Handler:**
```typescript
pi.on("turn_start", () => {
  extractAllowed = true;
});
```

**Why:** Each new user message is a new batch. The `extract` tool allows only one call per batch to prevent multiple parallel LLM requests that cause hangs and timeouts. The flag resets at the start of each turn so the next message can use `extract` again.

**Priority:** Medium — critical for preventing extract tool hangs.

---

## Event Flow

```
Session starts
    │
    ├─ session_start → detect current model, register .env provider
    │
    └─ User sends message
        │
        ├─ turn_start → reset extractAllowed = true
        │
        ├─ Tool calls (search_web, extract, get_current_date)
        │   │
        │   └─ extract:
        │       ├─ check extractAllowed flag
        │       │   ├─ false → return error immediately
        │       │   └─ true  → set extractAllowed = false
        │       ├─ capture original Pi model (provider, id, registry)
        │       ├─ switch to .env model (if .env configured)
        │       ├─ execute LLM call (resolveModel prefers .env)
        │       └─ finally: restore original Pi model (always)
        │
        └─ User sends next message
            │
            └─ turn_start → reset extractAllowed = true (repeat)

Session ends (exit, /reload, /fork)
    │
    └─ session_shutdown → reset envProviderRegistered
```

## Model Resolution Priority

The model is resolved in `resolveModel()` with this priority:

```
resolveModel()
    │
    ├─ Priority 1: .env (LLM_URL + LLM_MODEL)
    │   └─ Explicit override — checked first, always wins
    │
    └─ Priority 2: auto-detected from Pi
        ├─ ctx.model.id → detectedModelId
        ├─ ctx.model.baseUrl → detectedBaseUrl
        └─ fallback: ctx.modelRegistry.find(provider, modelId)
```

## Notes

- Events are subscribed to during extension initialization (`piWebsearch()` function).
- `session_start`, `model_select` handlers are async. Others are synchronous.
- The `turn_start` handler only resets the `extractAllowed` boolean flag.
- The `session_shutdown` handler resets `envProviderRegistered` for fresh provider registration.
- When `.env` is configured, `extract` tool **always** uses the `.env` model and **always** restores the original Pi model after execution.
- If no LLM configuration is found, `extract` throws an error.
