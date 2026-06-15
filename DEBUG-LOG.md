# DEBUG LOG — pi-websearch

## Проект
- **Путь:** `/home/test/workspace/pi-projects/pi-websearch`
- **Расширение pi:** `pi-websearch` (tools: `search_web`, `extract`, `get_current_date`)

## Проблема
Инструменты `search_web` и `extract` перестали работать после переезда на прокси-сервер `http://192.168.1.10:2001`.

## Причины и исправления

### 1. `buildChatUrl()` — дублирование `/v1`
**Было:** `.../api/v1` → `.../api/v1/v1/chat/completions`  
**Исправлено:** `lib/config.ts` — корректная конкатенация путей

### 2. `node:http`/`node:https` не работают с прокси
**Проблема:** Стандартные модули Node.js не читают `HTTP_PROXY`  
**Исправлено:** `lib/http.ts` — переписан на `undici` с `ProxyAgent`

### 3. Playwright не использует прокси
**Проблема:** Playwright не читает `HTTP_PROXY` из env  
**Исправлено:** `lib/extract.ts` — `getProxyConfig()` + `proxy` option при запуске chromium

### 4. Cline API обёртывает ответ в `{"data":{"choices":[...]}}`
**Проблема:** Код читал `response.choices`, а ответ в `response.data.choices`  
**Исправлено:** `lib/extract.ts` — `const inner = (data as any)?.data ?? data;`

### 5. `stream: false` не указан явно
**Проблема:** API стримил ответ по умолчанию  
**Исправлено:** `lib/extract.ts` — `stream: false` в body запроса

### 6. Ошибки возвращались как текст, а не бросались
**Проблема:** `extractContent` собирал ошибки в текст, агент не понимал что сломалось  
**Исправлено:** `lib/extract.ts` — `throw new Error()` при ошибке fetch

## Что НЕ исправлено

### search_web — DuckDuckGo блокирует через прокси
**Симптом:** DDG возвращает 202 Challenge / 302 Redirect при запросах через прокси  
**Проверено:**
- Без прокси — DDG работает (200 OK)
- С прокси через curl — 202 Challenge
- С прокси через undici — 202 Challenge
- С прокси через Playwright — challenge-form detected

**Корневая причина:** IP прокси-сервера `192.168.1.10:2001` заблокирован DuckDuckGo (anti-bot).

**Решение из оригинального проекта** (`/home/test/workspace/llm/pi-mcp-stack/webmcp`):
- Используется Python библиотека `ddgs` + `primp` с `impersonate="random", impersonate_os="random"`
- `primp` — TLS/HTTP fingerprint impersonation (подменяет TLS fingerprint на реальный браузер)
- Обходит защиту DDG

**Node.js аналог:**
- `node-tls-client` v2.1.0 — установлен, но не интегрирован
- Нужно заменить `undici` на `node-tls-client` в `lib/http.ts` или написать обёртку

## Текущее состояние
- ✅ `extract` — работает (загружает страницы через Playwright, LLM-вызов через undici)
- ✅ `get_current_date` — работает
- ✅ `search_web` — **исправлен**

## Исправление search_web (2026-06-15)

### Проблема
DDG возвращал 202 Challenge при запросах через прокси-сервер `http://192.168.1.10:2001`.

### Решение
В `lib/http.ts`:
1. Функция `getDispatcher()` теперь принимает опциональный URL
2. Добавлена `shouldBypassProxy(url)` — проверяет, что хост — `duckduckgo.com`
3. Для DDG-запросов используется `Agent` (прямое соединение, без прокси)
4. Для остальных запросов — `ProxyAgent` (через прокси, как раньше)
5. `new Dispatcher()` заменён на `new Agent()` — в undici v7 `Dispatcher` — абстрактный класс

### Проверено
- `search_web('hello world', 3)` → 3 результата (200 OK)
- `httpGet('https://httpbin.org/get')` → через прокси (Origin: 144.31.98.113)

### Почему не node-tls-client
- Требует скачивания 15.7 MB native .so библиотеки
- Native библиотека падает с Bus error (core dump) — несовместимость
- Решение с прямым соединением для DDG проще и надёжнее
