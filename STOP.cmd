@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
docker compose down
echo Остановлено. База сохранена в томе imago-db; стереть её: docker compose down -v
pause
