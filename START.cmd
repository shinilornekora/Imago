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

if "%IMAGO_PORT%"=="" set "IMAGO_PORT=8123"
echo Imago Studio: собираю и поднимаю Postgres + Document service + NGINX...
docker compose up --build -d
if errorlevel 1 (
  echo.
  echo Не поднялось — см. вывод выше. Логи: docker compose logs
  echo.
  pause
  exit /b 1
)
echo.
echo Готово: http://localhost:%IMAGO_PORT%/
echo Остановить: STOP.cmd ^(данные остаются^). Логи: docker compose logs -f
start "" "http://localhost:%IMAGO_PORT%/"
