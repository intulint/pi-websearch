# Баги

## tool_calls.log.json разбрасывался по проектам

**Статус:** ✅ исправлен (коммит `3d55c08`)

**Файл:** `lib/logger.ts`

### Описание

Расширение `pi-websearch` писало лог вызовов инструментов в файл `tool_calls.log.json`, используя `EXTENSION_DIR` (корневую папку расширения) как целевой путь:

```ts
// Было:
const TOOL_CALL_LOG_PATH = join(EXTENSION_DIR, "tool_calls.log.json");
```

Из-за этого файл создавался в каждом проекте, где активно расширение.

### Исправление

Путь изменён на `~/.pi/logs/pi-websearch/tool_calls.log.json` с автосозданием директории:

```ts
// Стало:
const TOOL_CALL_LOG_PATH = join(homedir(), ".pi", "logs", "pi-websearch", "tool_calls.log.json");
```

### Затронутые файлы (удалены)

- `/home/test/workspace/pi-projects/pi-model-select/tool_calls.log.json`
- `/home/test/workspace/pi-projects/api-docs/tool_calls.log.json`
- `/home/test/workspace/pi-projects/proxy-freeapi/tool_calls.log.json`
- `/home/test/workspace/pi-projects/pi-websearch/tool_calls.log.json`
- `/home/test/workspace/skills-pi/create-skill/tool_calls.log.json`
