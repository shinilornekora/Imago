# `deploy/`, `docker-compose.yml`, `START.cmd`, `STOP.cmd` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Развёртывание системы (SPEC §8.1): четыре контейнера — `db` (postgres:16-alpine, том `imago-db`), `document` (Document service, :8080), `orchestrator` (агент, :8090), `web` (nginx: статика клиента + прокси). Описание одной заметкой на каталог: файлы короткие и сами прокомментированы.

## Файлы
| Файл | Что делает |
|---|---|
| `deploy/Dockerfile.document` | node:22-alpine, `npm ci --omit=dev`, копирует `src/` целиком (движок общий) и `server/document` |
| `deploy/Dockerfile.orchestrator` | то же, но `server/orchestrator`; к базе не ходит |
| `deploy/Dockerfile.web` | сборка `tools/build.mjs` → `dist/web` (`IMAGO_DEFAULTS.server:true`), затем nginx:1.27-alpine |
| `deploy/nginx.conf` | `/` — статика; `/api/` и `/ws` → document; `/agent/` → orchestrator (SSE без буфера); `/api/internal/` закрыт снаружи; ошибки 413/502/504 — тем же JSON-телом `{error:true, code, …, upstream}` и заголовком `X-Imago-Upstream` (их понимает `src/agent.js`) |
| `deploy/env.example` | образец `.env`: модель агента (LLM_*), порт, INTERNAL_TOKEN |
| `docker-compose.yml` | сервисы, зависимости и health-check'и, переменные из `.env` |
| `START.cmd` / `STOP.cmd` | Windows: проверка Docker Desktop, `.env` из образца при первом запуске, `docker compose up` / `down` (база остаётся в томе; стереть — `down -v`) |

## Инварианты
- Образы документа и агента копируют `src/` целиком — сайдкары `*.llm.md` туда не нужны и исключены `.dockerignore`.
- INTERNAL_TOKEN = «change-me» или пусто — внутренние маршруты отвечают 403 (трассы не пишутся).

## Отладка
`docker compose up --build`; `curl localhost/api/health`, `curl localhost/agent/health`. Тест конфигурации — `test/deploy.test.mjs`.

## Ссылки
- SPEC: §8.1, §9.2, §10.2; ЗАПУСК.md, `server/document/README.md`, `server/orchestrator/README.md`
