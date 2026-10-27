# `server/orchestrator/llm/index.js` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Клиент модели агента (SPEC §10.1, стрелки 8/9): OpenAI-совместимый (LM Studio, vLLM, Ollama, OpenRouter) или Anthropic Messages API. Провайдер — `makeProvider` из `src/brain.js` (повторы, бюджет, разбор JSON — тот же, что в браузере).

## Главное
- `createLlm(cfg)` (≈124) → `{kind, configured, model, provider, health, redact, describe, markDown}` (вызовы модели — через `provider` из brain).
- `parseLlmUrl(raw)` — учётные данные из адреса (`user:pass@`) уходят заголовком `Authorization` (Basic / Bearer), query сохраняется; `endpoint(base, query, suffix)` — суффикс (`chat/completions`, `models`, `v1/messages`) дописывается к пути.
- `secretGrams` / `maskGrams` (`SECRET_GRAM` = 8) — маскировка ключа и его кусков в любом выходящем тексте.
- Здоровье — `LLM_HEALTH_TIMEOUT_MS`, кеш `LLM_HEALTH_CACHE_MS`; openai без LLM_MODEL берёт первую из `/models`.

## Инварианты
Ключ и userinfo никогда не попадают в ответы, ошибки, трассы и логи — всё наружу через `redact`.

## Подводные камни
Тело ответа модели ограничено `MODEL_BODY_MAX_BYTES` (LLM_MAX_BODY_BYTES, 8 МБ) → `llm_bad_response` (круг 31).

## Ссылки
- SPEC: §10.1, §10.10
- Тесты: `test/orchestrator/llm`, `round33`
