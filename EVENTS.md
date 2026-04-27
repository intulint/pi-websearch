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
    ├─ session_start → detect current model
    │
    └─ User sends message
        │
        ├─ turn_start → reset extractAllowed = true
        │
        ├─ Tool calls (search_web, extract, get_current_date)
        │   │
        │   └─ extract: check extractAllowed flag
        │       ├─ true → execute, set extractAllowed = false
        │       └─ false → return error immediately
        │
        └─ User sends next message
            │
            └─ turn_start → reset extractAllowed = true (repeat)
```

## Model Detection Flow

```
session_start / model_select
    │
    ├─ Priority 1: ctx.model.baseUrl
    │   └─ Direct access to model's baseUrl
    │
    ├─ Priority 2: ctx.modelRegistry.find(provider, modelId)
    │   └─ Look up baseUrl from model registry
    │
    └─ Fallback: .env variables (LLM_URL, LLM_MODEL)
        └─ Explicit override from .env file
```

## Notes

- Events are subscribed to during extension initialization (`piWebsearch()` function).
- All event handlers are synchronous except `session_start` and `model_select` which are async.
- The `turn_start` handler is synchronous and only resets a boolean flag.
- If no LLM configuration is found, the extension logs a warning but continues loading.
