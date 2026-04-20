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
│  SearXNG (self-hosted)                    │
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
   │    ├─ 3.4. Подписывается на события Pi: model_select, session_start
   │    │     → Обновляет currentModelId / currentProviderBaseUrl
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
    ├─ SEARCH_PROVIDER === "ddg" ?
    │   │
    │   ├─ YES → searchDdg(query, limit)
    │   │     │
    │   │     ├─ HTTPS GET with browser-like headers
    │   │     │   (User-Agent rotation, Sec-Fetch-*, sec-ch-ua)
    │   │     │
    │   │     └─ → SearchResult[] { title, url, description }
    │   │
    │   └─ NO  → searchSearxng(query, limit)
    │         │
    │         ├─ HTTP GET {SEARXNG_URL}/search?q=...&format=json
    │         │
    │         └─ → SearchResult[] { title, url, description }
    │
    ├─ logToolCall("search_web", params, JSON.stringify(data))
    │   → tool_calls.log.json
    │
    ▼
{ content: [{ type: "text", text: '[{"title":"...","url":"...","description":"..."}]' }] }
```

**Зависимости:** DuckDuckGo HTML API или SearXNG (self-hosted)

**Таймауты:** 30 секунд на запрос

---

### 3. extract

```
Пользователь: "извлеки цены с этих страниц"
    │
    ▼
pi.registerTool({ name: "extract" }) → execute(params)
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
    │   │   ├─ HTTP GET url (timeout 60s)
    │   │   │
    │   │   ├─ extractTitle(html) → "<title>..."
    │   │   │
    │   │   ├─ htmlToClean(html):
    │   │   │   1. Strip <script>
    │   │   │   2. Strip <style>
    │   │   │   3. Strip all tags → " "
    │   │   │   4. Collapse whitespace
    │   │   │   5. Collapse newlines
    │   │   │
    │   │   ├─ text.length < 50 ?
    │   │   │   └─ YES → fallback cleaning (tags → "\n")
    │   │   │
    │   │   └─ { title, text, error? }
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

**Зависимости:** Local LLM (OpenAI-compatible API)

**Таймауты:** 60 секунд на fetch, 10 минут на LLM

---

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
| `SEARCH_PROVIDER` | Нет | `ddg` | `ddg` или `searxng` |
| `SEARXNG_URL` | Условн. | — | URL SearXNG (если searxng) |

## Структура файлов

```
pi-websearch/
├── pi-websearch.ts              # Основной код расширения
├── package.json          # Метаданные пакета
├── README.md             # Документация
├── ARCHITECTURE.md       # Этот файл
├── .env.example          # Пример конфига (опционально)
├── .gitignore            # Игнорирование файлов
├── LICENSE               # MIT
└── tool_calls.log.json   # Лог вызовов инструментов (создаётся автоматически)
```

## Потенциальные улучшения

1. **Caching** — кэшировать результаты поиска/экстракции
2. **Rate limiting** — ограничить частоту запросов
3. **Progress updates** — отправлять onUpdate при долгой экстракции
4. **Structured output** — парсить JSON из LLM ответа
5. **Error recovery** — retry при таймаутах
