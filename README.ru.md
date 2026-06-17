# pi-websearch

<div align="center">

**[🇬🇧 English](README.md) · [🇷🇺 Русский](README.ru.md)**

</div>

---

**pi-websearch** — лёгкое Pi-расширение для веб-поиска и извлечения структурированных данных. Без стадии сборки, использует `playwright` и `typebox`, и требует `@mariozechner/pi-coding-agent` + `@mariozechner/pi-tui` как peer dependencies. Сложил — и работает.

## Установка

Установка через `pi install`:

```bash
pi install https://github.com/intulint/pi-websearch
```

Или установка из локальной папки:

```bash
pi install ./path/to/pi-websearch
```

### Требования для локальной разработки

Если запускаете расширение прямо из директории проекта (без `pi install`), сначала установите зависимости:

```bash
npm install
npx playwright install chromium
```

Pi загружает `.ts`-файлы через jiti без стадии сборки, но `node_modules` должен присутствовать для runtime-импортов (например, `playwright`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui` peer dependencies).

## Инструменты

### `search_web`

Поиск в интернете через DuckDuckGo (HTML-скрейпинг). Возвращает JSON-строку массива `{ title, url, description }`.


```typescript
search_web({
  query: "последние новости ИИ",
  limit: 5  // необязательно, по умолчанию 10
})
```

Возвращает JSON-строку:
```json
[{
  "title": "Заголовок новости ИИ",
  "url": "https://example.com/ai-news",
  "description": "Описание новостной статьи..."
}]
```

### `extract`

Извлечение структурированных данных из одного или нескольких URL. Загружает страницы (с опциональным режимом браузера Playwright), извлекает читаемый контент и отправляет в LLM для структурированного извлечения. Использует модель из `.env` или текущую модель Pi. Перед `extract` используйте `search_web` для поиска URL.


```typescript
extract({
  urls: ["https://example.com/page1", "https://example.com/page2"],
  prompt: "Извлеки все цены и названия товаров",
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
  useBrowser: true  // необязательно, по умолчанию true
})
```

### `get_current_date`

Получить текущую дату в формате ISO с днем недели.

```typescript
get_current_date()
// Возвращает: "2024-01-15 (Monday)"
```

## Конфигурация

При желании создайте файл `.env` в директории расширения:

```env
# Явная модель LLM (переопределяет автоопределение из Pi)
LLM_URL=http://localhost:1234
LLM_MODEL=qwen3.5-27b
LLM_API_KEY=your-api-key-here  # опционально, для аутентифицированных эндпоинтов
```


| Переменная | Требуется | По умолчанию | Описание |
|------------|----------|---------|-------------|
| `LLM_URL` | Нет | - | Явный эндпоинт LLM (переопределяет автоопределение) |
| `LLM_MODEL` | Нет | - | Явное имя модели (переопределяет автоопределение) |
| `LLM_API_KEY` | Нет | - | API ключ для аутентифицированных эндпоинтов |

## Настройка прокси

Расширение уважает переменные окружения `HTTP_PROXY`, `HTTPS_PROXY` и `NO_PROXY`:

- **`search_web` (DuckDuckGo):** Прямое соединение к `duckduckgo.com` (прокси обход)
  - DuckDuckGo блокирует запросы через прокси-сервер (202 Challenge)
  - Используется прямое соединение `Agent`, без прокси

- **`extract` (Playwright):** Использует прокси с обходом `NO_PROXY`
  - Прокси configured через опцию `proxy` в Playwright
  - Уважает переменную `NO_PROXY`

- **`extract` (HTTP fallback):** Использует прокси для простых страниц
  - HTTP GET запросы уважают `HTTP_PROXY`/`HTTPS_PROXY`
  - Используется `undici` с `ProxyAgent`

## Выбор модели

Расширение выбирает модель LLM по следующему приоритету:

1. **Явная модель из `.env`** — если существует `.env` с `LLM_URL` и `LLM_MODEL`, они используются для LLM-вызовов в `extract`.
2. **Автоопределение из Pi** — если нет `.env`, расширение использует текущую активную модель в Pi.

## Зависимости

Runtime (в `package.json`):
- `typebox` — определения схем для параметров инструментов
- `playwright` — извлечение контента через браузер (JS-интенсивные сайты)

Peer:
- `@mariozechner/pi-coding-agent` — API расширений Pi
- `@mariozechner/pi-tui` — компоненты TUI Pi (Text и др.)

Транзитивные (через undici в node_modules):
- `undici` — HTTP-клиент с поддержкой прокси
- `node:zlib` — декомпрессия (gzip, br, deflate)

> **Примечание:** `playwright` требует установки бинарников Chromium. Запустите `npx playwright install chromium` после `npm install`.

## Лицензия

MIT
