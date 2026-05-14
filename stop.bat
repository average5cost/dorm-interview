@echo off
chcp 65001 >nul
title Dorm Interview - Stop
cd /d "%~dp0"
echo Stopping Dorm Interview server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo Killing PID: %%a
  taskkill /F /PID %%a >nul 2>&1
  echo Done.
)
pause
