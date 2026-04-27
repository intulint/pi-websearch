# pi-websearch — Архитектура расширения

## Общая схема

```
Pi Coding Agent
    │
    │  /reload
    │
    ▼
┌─────────────────────────┐
│  pi-websearch extension     │
│  pi-websearch.ts                │
│                          │
│  pi.registerTool() × 3   │
│  ┌────────────────────┐  │
│  │ get_current_date   │  │
│  │ search_web         │  │
│  │ extract            │  │
│  └────────────────────┘  │
└─────────────────────────┘
    │
    │  HTTP calls
    │
    ▼
┌──────────────────────────────────────────┐
│  External Services                        │
│                                           │
│  DuckDuckGo HTML (html.duckduckgo.com)   │
│  Local LLM (OpenAI-compatible API)        │
└──────────────────────────────────────────┘
```

## Жизненный цикл расширения

```
1. Pi запускается
   │
   ├─ 2. Загружает все файлы из ~/.pi/agent/extensions/
   │
   ├─ 3. Выполняет pi-websearch.ts pi-websearch
   │    │
   │    ├─ 3.1. Загружает .env из директории расширения (если существует)
   │    │     → process.env.LLM_URL, process.env.LLM_MODEL
   │    │
   │    ├─ 3.2. Определяет модель LLM (приоритет: .env > auto-detect из Pi)
   │    │
   │    ├─ 3.3. Выводит конфиг в консоль
   │    │     → "pi-websearch: Loading web search and extraction tools"
   │    │
   │    ├─ 3.4. Подписывается на события Pi: model_select, session_start, turn_start
   │    │     → Обновляет currentModelId / currentProviderBaseUrl
   │    │     → Сбрасывает extractAllowed флаг при новом сообщении
   │    │
   │    └─ 3.5. Регистрирует 3 инструмента через pi.registerTool()
   │          → get_current_date, search_web, extract
   │
   ├─ 4. Pi вызывает инструменты по запросу пользователя
   │
   └─ 5. При /reload — расширение перезагружается
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
    ├─ searchDdg(query, limit)
    │     │
    │     ├─ HTTPS GET with browser-like headers
    │     │   (User-Agent rotation, Sec-Fetch-*, sec-ch-ua)
    │     │
    │     └─ → SearchResult[] { title, url, description }
    │
    ├─ logToolCall("search_web", params, JSON.stringify(data))
    │   → tool_calls.log.json
    │
    ▼
{ content: [{ type: "text", text: '[{"title":"...","url":"...","description":"..."}]' }] }
```

**Зависимости:** DuckDuckGo HTML API

**Таймауты:** 30 секунд на запрос

**Rate limits:** DuckDuckGo блокирует при частых запросах. WARNING в description инструмента.

---

### 3. extract

```
Пользователь: "извлеки цены с этих страниц"
    │
    ▼
pi.registerTool({ name: "extract" }) → execute(params)
    │
    ├─ check extractAllowed flag
    │   │
    │   ├─ false → return error immediately (batch restriction)
    │   └─ true  → set extractAllowed = false
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
    ├─ for each url in urls:
    │   │
    │   ├─ fetchPage(url, useBrowser)
    │   │   │
    │   │   ├─ Playwright browser (if useBrowser)
    │   │   │   → headless chromium, timeout 60s
    │   │   │
    │   │   └─ HTTP GET + HTML cleaning (if !useBrowser)
    │   │       → timeout 60s
    │   │
    │   └─ result.error ?
    │       └─ YES → "=== url ===\nFailed: error"
    │       └─ NO  → "=== url ===\ntitle\n\ntext (max 12000 chars)"
    │
    ├─ combined = contents.join("\n\n")
    │
    ├─ llmExtract(combined, prompt, schema)
    │   │
    │   ├─ System prompt:
    │   │   "You are a data extraction assistant..."
    │   │   + schema (if provided)
    │   │
    │   ├─ User content:
    │   │   combined + "\n\n---\nExtraction request: prompt"
    │   │
    │   ├─ HTTP POST {LLM_URL}/v1/chat/completions
    │   │   {
    │   │     model: LLM_MODEL,
    │   │     messages: [{ role: "system", ... }, { role: "user", ... }],
    │   │     temperature: 0.1
    │   │   }
    │   │
    │   └─ response.choices[0].message.content
    │
    ├─ logToolCall("extract", params, result)
    │   → tool_calls.log.json
    │
    ▼
{ content: [{ type: "text", text: llmExtract_result }] }
```

**Зависимости:** Local LLM (OpenAI-compatible API), Playwright (optional)

**Таймауты:** 60 секунд на fetch, 10 минут на LLM

**Batch restriction:** Only one extract per batch. Resets on `turn_start`.

---

## Batch Tracking

```
turn_start (new user message)
    │
    └─ extractAllowed = true  (reset)

extract call #1
    │
    ├─ extractAllowed === true  → execute, set extractAllowed = false
    │
    └─ extract call #2+ (same batch)
        │
        └─ extractAllowed === false → return error immediately
```

This prevents multiple parallel LLM requests that cause hangs and timeouts.

## Взаимодействие с Pi API

```typescript
// Регистрация инструмента
pi.registerTool({
  name: string,           // Имя инструмента
  label: string,          // Отображаемое имя
  description: string,    // Описание для LLM
  parameters: TypeObject, // Schema для валидации
  execute: (toolCallId, params, signal, onUpdate, ctx) => Promise<{
    content: Array<{ type: string; text?: string }>,
    details?: Record<string, unknown>
  }>
})

// События
pi.on("session_start", (event, ctx) => { ... })
pi.on("model_select", (event, ctx) => { ... })
pi.on("turn_start", () => { ... })
```

## Обработка ошибок

```
HTTP Error
    │
    ├─ Timeout → "Request timeout"
    ├─ Status 3xx → Redirect (follow up to 10)
    ├─ Status 4xx/5xx → "HTTP {status}: {response_slice}"
    └─ Network error → Error message
    │
    ▼
Tool returns { content: [{ type: "text", text: error }] }

Batch Error (extract)
    │
    └─ "Extract tool is already running in this batch..."
```

## Логирование

```
tool_calls.log.json
├── [
│     {
│       "logged_at": "2024-01-15T10:30:00.000Z",
│       "tool": "search_web",
│       "arguments": { "query": "AI news", "limit": 10, "provider": "ddg" },
│       "result": "[{\"title\":\"...\",\"url\":\"...\",\"description\":\"...\"}]"
│     },
│     ...
│   ]  (max 10 entries)
```

## Конфигурация

| Переменная | _required_ | По умолчанию | Описание |
|------------|-----------|---------------|----------|
| `LLM_URL` | Нет | — | Explicit LLM endpoint (приоритет над auto-detect) |
| `LLM_MODEL` | Нет | — | Explicit model name (приоритет над auto-detect) |

> **Note:** SearXNG support has been removed. Only DuckDuckGo is available.

## Структура файлов

```
pi-websearch/
├── pi-websearch.ts              # Основной код расширения
├── package.json          # Метаданные пакета
├── README.md             # Документация
├── ARCHITECTURE.md       # Этот файл
├── EVENTS.md             # События Pi, используемые расширением
├── AGENTS.md             # Инструкции для агента
├── INSIGHTS.md           # Инсайты по DuckDuckGo парсингу
├── .env.example          # Пример конфига (опционально)
├── .gitignore            # Игнорирование файлов
├── LICENSE               # MIT
└── tool_calls.log.json   # Лог вызовов инструментов (создаётся автоматически)
```

## Потенциальные улучшения

1. **Caching** — кэшировать результаты поиска/экстракции
2. **Progress updates** — отправлять onUpdate при долгой экстракции
3. **Structured output** — парсить JSON из LLM ответа
4. **Error recovery** — retry при таймаутах
