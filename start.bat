@echo off
chcp 65001 >nul
title Dorm Interview
cd /d "%~dp0"
echo.
echo ================================
echo    Dorm Interview - Starting...
echo ================================
echo.
node server.js
pause
