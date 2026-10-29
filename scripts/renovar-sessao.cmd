@echo off
chcp 65001 >nul
title Renovar sessao Codental
echo Renovando a sessao do Codental (nao feche o navegador que abrir)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0refresh-session-local.ps1"
set RC=%ERRORLEVEL%
echo.
powershell -NoProfile -Command "Get-Content \"$env:LOCALAPPDATA\codental-refresh\refresh.log\" -Tail 14 -Encoding UTF8"
echo.
if %RC%==0 (echo Concluido com sucesso.) else (echo Falhou - codigo %RC%. Veja as linhas acima.)
echo.
pause
