@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where docker >nul 2>&1
if errorlevel 1 (
  echo.
  echo Нужен Docker Desktop: https://www.docker.com/products/docker-desktop/
  echo Без него можно запустить соло-режим без сервера: dist\local\START.cmd
  echo ^(сначала node tools\build.mjs^).
  echo.
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo Docker Desktop установлен, но не запущен. Запустите его и повторите.
  echo.
  pause
  exit /b 1
)

rem Переменные — в .env рядом с docker-compose.yml; первый запуск берёт образец
if not exist ".env" (
  copy /y "deploy\env.example" ".env" >nul
  echo Создан .env из deploy\env.example — модель агента и порт меняются там.
)
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="IMAGO_PORT" if not defined IMAGO_PORT set "IMAGO_PORT=%%B"
)
if "%IMAGO_PORT%"=="" set "IMAGO_PORT=8123"

echo Imago Studio: собираю и поднимаю Postgres + Document service + Orchestrator + NGINX...
echo ^(первый раз — несколько минут; дальше быстрее. Миграции базы идут сами.^)
docker compose up --build -d --wait
if errorlevel 1 (
  echo.
  echo Не поднялось — см. вывод выше. Состояние: docker compose ps   Логи: docker compose logs
  echo.
  pause
  exit /b 1
)

echo.
echo Готово: http://localhost:%IMAGO_PORT%/
echo Агент на сервере ^(llm: up — модель отвечает, down — запустите LM Studio^):
curl -s "http://localhost:%IMAGO_PORT%/agent/health"
echo.
echo Остановить: STOP.cmd ^(данные остаются^). Логи: docker compose logs -f
start "" "http://localhost:%IMAGO_PORT%/"
