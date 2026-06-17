# pi-websearch - Архитектура расширения

## Новая структура (после рефакторинга)

```
pi-websearch/
├── pi-websearch.ts          # Entry point - extension registration + event handlers
├── lib/
│   ├── config.ts            # .env loading, model resolution, env provider setup
│   ├── extract.ts           # Page fetching (HTTP + Playwright) + LLM extraction
│   ├── http.ts              # Unified HTTP client (GET/POST, redirects, decompression)
│   ├── logger.ts            # Tool call logging with debounce (tool_calls.log.json)
│   └── search.ts            # DuckDuckGo search + scraping logic
├── package.json
├── tsconfig.json
├── .env                     # LLM config (not committed)
├── .env.example
├── .gitignore
├── node_modules/
└── tool_calls.log.json      # Generated automatically
```

## Разделение ответственности

| Модуль | Задачи | Зависимости |
|--------|--------|-------------|
| `pi-websearch.ts` | Регистрация инструментов, подписка на события Pi, управление состоянием | config, logger, search, extract |
| `lib/config.ts` | `.env` парсинг, `resolveModel()`, `buildChatUrl()`, `resolveModelFromPi()` | fs, path |
| `lib/http.ts` | Unified HTTP client: GET/POST, redirects, gzip/br/deflate, timeouts, abort signals | node:*, node:zlib |
| `lib/logger.ts` | Debounced tool call logging - in-memory buffer + periodic flush | config (EXTENSION_DIR), fs, path |
| `lib/search.ts` | DuckDuckGo HTML scraping, `searchDdg()`, UA rotation | http |
| `lib/extract.ts` | `fetchPage()`, `fetchPageWithBrowser()`, `llmExtract()`, `extractContent()` | config, http, logger, playwright (опционально) |

## Жизненный цикл расширения

```
1. Pi запускается
   │
   ├─ 2. Загружает pi-websearch.ts
   │
   ├─ 3. Выполняет pi-websearch() - factory function
   │    │
   │    ├─ 3.1. initConfig(EXTENSION_DIR) - инициализация пути
   │    │
   │    ├─ 3.2. Подписывается на события Pi: model_select, session_start,
   │    │     session_shutdown, turn_start
   │    │
   │    └─ 3.3. Регистрирует 3 инструмента через pi.registerTool()
   │          → get_current_date, search_web, extract
   │
   ├─ 4. Pi вызывает инструменты по запросу пользователя
   │
   └─ 5. При /reload - расширение перезагружается
        → config.ts перезагружает .env (lazy reload через ensureEnvLoaded())
```

## Потоки данных по инструментам

### 1. get_current_date

```
Пользователь: "какая сегодня дата?"
    │
    ▼
pi.registerTool → execute()
    │
    ├─ new Date()
    ├─ toISOString().split("T")[0]  → "2024-01-15"
    ├─ getUTCDay() → dayNames[1]    → "Monday"
    │
    ▼
{ content: [{ type: "text", text: "2024-01-15 (Monday)" }] }
```

**Зависимости:** None (только stdlib)

---

### 2. search_web

```
Пользователь: "поищи последние новости AI"
    │
    ▼
pi.registerTool({ name: "search_web" }) → execute(params)
    │
    ├─ params = { query: "последние новости AI", limit: 10 }
    │
    ├─ searchDdg(query, limit)         ← lib/search.ts
    │     │
    │     ├─ HTTPS GET with browser-like headers
    │     │   (User-Agent rotation, Sec-Fetch-*, sec-ch-ua)
    │     │
    │     ├─ gzip/br decompression (zlib)
    │     │
    │     └─ → SearchResult[] { title, url, description }
    │
    ├─ logToolCall("search_web", params, JSON.stringify(data))
    │   → tool_calls.log.json            ← lib/logger.ts
    │
    ▼
{ content: [{ type: "text", text: '[{"title":"...","url":"...","description":"..."}]' }] }
```

**Зависимости:** DuckDuckGo HTML API

**Таймауты:** 15 секунд на запрос (DDG_TIMEOUT_MS = 15_000)

**Rate limits:** DuckDuckGo блокирует при частых запросах. WARNING в description инструмента.

---

### 3. extract

```
Пользователь: "извлеки цены с этих страниц"
    │
    ▼
pi.registerTool({ name: "extract" }) → execute(params)
    │
    ├─ check _extractAllowed flag        ← module-level state в main
    │   │
    │   ├─ false → return error (batch restriction)
    │   └─ true  → set _extractAllowed = false
    │
    ├─ Capture original Pi model (provider, id, registry entry)
    │
    ├─ params = {
    │     urls: ["https://site1.com", "https://site2.com"],
    │     prompt: "Извлеки все цены товаров",
    │     schema: null,
    │     useBrowser: true
    │   }
    │
    ├─ (!prompt && !schema) ?
    │   └─ YES → return error
    │
    ├─ Switch to .env model via setModel() (if .env configured)
    │   → Pi UI reflects active model change
    │
    ├─ extractContent(urls, prompt, schema, useBrowser)  ← lib/extract.ts
    │   │
    │   ├─ for each url in urls:
    │   │   │
    │   │   ├─ fetchPage(url, useBrowser)
    │   │   │   │
    │   │   │   ├─ Playwright browser (if useBrowser)
    │   │   │   │   → headless chromium, timeout 60s
    │   │   │   │
    │   │   │   └─ HTTP GET + HTML cleaning (if !useBrowser)
    │   │   │       → timeout 60s
    │   │   │
    │   │   └─ result.error ?
    │   │       └─ YES → "=== url ===\nFailed: error"
    │   │       └─ NO  → "=== url ===\ntitle\n\ntext (max 12000 chars)"
    │   │
    │   ├─ combined = contents.join("\n\n")
    │   │
    │   ├─ llmExtract(combined, prompt, schema)
    │   │   │
    │   │   ├─ resolveModel() → prefers .env config  ← lib/config.ts
    │   │   │   → if .env exists: uses .env URL/model/apiKey
    │   │   │   → if no .env: uses auto-detected Pi model
    │   │   │
    │   │   ├─ System prompt:
    │   │   │   "You are a data extraction assistant..."
    │   │   │   + schema (if provided)
    │   │   │
    │   │   ├─ User content:
    │   │   │   combined + "\n\n---\nExtraction request: prompt"
    │   │   │
    │   │   ├─ HTTP POST {LLM_URL}/v1/chat/completions
    │   │   │   {
    │   │   │     model: LLM_MODEL,
    │   │   │     messages: [{ role: "system", ... }, { role: "user", ... }],
    │   │   │     temperature: 0.1,
    │   │   │     stream: false,
    │   │   │     Headers: { Authorization: Bearer {apiKey} }
    │   │   │   }
    │   │   │
    │   │   └─ response.choices[0].message.content
    │   │
    │   ├─ logToolCall("extract", params, result)  ← lib/logger.ts
    │   │   → tool_calls.log.json
    │
    ├─ Finally: restore original Pi model via setModel()
    │   → Always restores, even on error
    │
    ▼
{ content: [{ type: "text", text: llmExtract_result }] }
```

**Зависимости:** Local LLM (OpenAI-compatible API), Playwright (optional)

**Таймауты:** 60 секунд на fetch (FETCH_TIMEOUT_MS), 10 минут на LLM (LLM_TIMEOUT_MS)

**Batch restriction:** Only one extract per batch. Resets on `turn_start` event via module-level state variable `_extractAllowed`.

---

## Batch Tracking

```
turn_start (new user message)
    │
    └─ _extractAllowed = true  (reset via module-level state in pi-websearch.ts)

extract call #1
    │
    ├─ _extractAllowed === true  → execute, set _extractAllowed = false
    │
    └─ extract call #2+ (same batch)
        │
        └─ _extractAllowed === false → return error immediately
```

## Зависимости между модулями

```
pi-websearch.ts
    ├── lib/config.ts         (initConfig, resolveModelFromPi, cachedEnv*)
    ├── lib/logger.ts         (logToolCall, flushLogs)
    ├── lib/search.ts         (searchDdg)
    └── lib/extract.ts        (extractContent)

lib/search.ts
    └── lib/http.ts           (httpGetRaw)

lib/extract.ts
    ├── lib/config.ts         (resolveModel, buildChatUrl)
    ├── lib/http.ts           (httpGet, httpPostJson)
    └── lib/logger.ts         (logToolCall)

lib/logger.ts
    └── lib/config.ts         (EXTENSION_DIR)

lib/config.ts
    └── fs, path

lib/http.ts
    └── node:zlib, undici

lib/search.ts
    └── lib/http.ts           (httpGetRaw)

lib/extract.ts
    └── playwright (dynamic import)
```

## Конфигурация

| Переменная | _required_ | По умолчанию | Описание |
|------------|-----------|---------------|----------|
| `LLM_URL` | Нет | - | Explicit LLM endpoint (приоритет над auto-detect) |
| `LLM_MODEL` | Нет | - | Explicit model name (приоритет над auto-detect) |
| `LLM_API_KEY` | Нет | - | API key для аутентифицированных эндпоинтов |
