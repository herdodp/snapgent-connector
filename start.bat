@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Snapgent Bridge
cd /d "%~dp0"

if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>nul
set "LOGFILE=%~dp0logs\start.log"

if not exist "%~dp0bridge.exe" (
    echo.
    echo   ERROR: bridge.exe not found next to start.bat.
    echo   Extract the whole download, then run start.bat from that folder.
    echo.
    pause
    exit /b 1
)

REM Free the bridge port if a previous instance is still listening.
set "OLDPID="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :17613 ^| findstr LISTENING 2^>nul') do (
    set "OLDPID=%%a"
)
if defined OLDPID (
    echo   Replacing previous bridge ^(pid !OLDPID!^) on port 17613...
    taskkill /F /T /PID !OLDPID! >nul 2>nul
    timeout /t 1 /nobreak >nul
)

echo.
echo   +--------------------------------------------------+
echo   ^| Snapgent is now running.                         ^|
echo   ^| Keep this window open while you use the agent.   ^|
echo   ^| Minimise it freely - closing it stops the bridge.^|
echo   +--------------------------------------------------+
echo.

"%~dp0bridge.exe"
set "BRIDGE_EXIT=%errorlevel%"

echo.
if not "%BRIDGE_EXIT%"=="0" (
    echo   Bridge stopped with ERROR code %BRIDGE_EXIT%.
) else (
    echo   Bridge stopped normally.
)
echo   Press any key to close.
pause >nul
exit /b 0
