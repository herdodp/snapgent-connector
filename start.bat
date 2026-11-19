@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Snapgent Bridge
cd /d "%~dp0"

if not exist "logs" mkdir "logs" >nul 2>nul
set "LOGFILE=%~dp0logs\start.log"
set "BRIDGE_PORT=%ZS_BRIDGE_PORT%"
if not defined BRIDGE_PORT set "BRIDGE_PORT=17613"

echo.
echo   === Snapgent Bridge (Windows) ===
echo.
>>"%LOGFILE%" echo %date% %time% ===== start.bat launched =====

if not exist "bridge.py" if not exist "bridge.exe" (
    echo   ERROR: no Windows-compatible Snapgent bridge was found.
    echo   Extract the complete release, including bridge.py or bridge.exe.
    goto :error_exit
)

echo   [1/4] Looking for Python 3.9+...
set "PY_CMD="
if exist "bridge.py" (
    where py >nul 2>nul
    if not errorlevel 1 (
        py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
        if not errorlevel 1 set "PY_CMD=py -3"
    )
    if not defined PY_CMD (
        where python >nul 2>nul
        if not errorlevel 1 (
            python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
            if not errorlevel 1 set "PY_CMD=python"
        )
    )
)
if defined PY_CMD (
    echo         Found: !PY_CMD!
    >>"%LOGFILE%" echo %date% %time% Python found: !PY_CMD!
) else (
    echo         Python 3.9+ not found; checking for bundled bridge.exe.
)

echo   [2/4] Checking websockets library...
set "BRIDGE_MODE="
if defined PY_CMD (
    !PY_CMD! -c "import websockets" >nul 2>nul
    if errorlevel 1 (
        echo         Installing websockets - first time only...
        !PY_CMD! -m pip install --user websockets
    )
    !PY_CMD! -c "import websockets" >nul 2>nul
    if not errorlevel 1 set "BRIDGE_MODE=python"
)
if not defined BRIDGE_MODE if exist "bridge.exe" set "BRIDGE_MODE=exe"
if not defined BRIDGE_MODE (
    echo   ERROR: no usable bridge was found.
    echo   Install Python 3.9+ and websockets, or include bridge.exe.
    goto :error_exit
)
if "%BRIDGE_MODE%"=="python" (
    echo         OK - using bridge.py with the latest source changes.
) else (
    echo         Using bundled bridge.exe. Source-only features require Python and websockets.
)

echo   [3/4] Detecting VS Code, Roblox Studio, and EffectCraft...
if exist "setup-config.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-config.ps1"
    if errorlevel 1 (
        echo   ERROR: MCP configuration failed. See the message above.
        goto :error_exit
    )
) else (
    echo         MCP auto-configuration is unavailable in this package.
)
if exist "start-effectcraft.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-effectcraft.ps1"
)

echo   [4/4] Starting bridge...
set "OLDPID="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /C:":%BRIDGE_PORT%" ^| findstr LISTENING 2^>nul') do set "OLDPID=%%a"
if defined OLDPID (
    echo         Replacing previous bridge ^(pid !OLDPID!^) on port %BRIDGE_PORT%...
    >>"%LOGFILE%" echo %date% %time% Replacing bridge pid !OLDPID! on port %BRIDGE_PORT%.
    taskkill /F /T /PID !OLDPID! >nul 2>nul
    timeout /t 1 /nobreak >nul
)

echo.
echo   ############################################################
echo   ##   KEEP THIS WINDOW OPEN - DO NOT CLOSE IT              ##
echo   ##   Snapgent stops working if you close it. Just       ##
echo   ##   minimize this window and leave it running.           ##
echo   ############################################################
echo.

if "%BRIDGE_MODE%"=="python" (
    >>"%LOGFILE%" echo %date% %time% Launching bridge.py with %PY_CMD%.
    %PY_CMD% "bridge.py"
) else (
    >>"%LOGFILE%" echo %date% %time% Launching bridge.exe.
    "bridge.exe"
)
set "BRIDGE_EXIT=%errorlevel%"
>>"%LOGFILE%" echo %date% %time% Bridge exited with code %BRIDGE_EXIT%.

echo.
if not "%BRIDGE_EXIT%"=="0" (
    echo   Bridge stopped with ERROR code %BRIDGE_EXIT%. See logs\start.log.
) else (
    echo   Bridge stopped normally.
)
echo   Press any key to close.
pause >nul
exit /b %BRIDGE_EXIT%

:error_exit
>>"%LOGFILE%" echo %date% %time% Launcher failed before bridge startup.
echo.
echo   Press any key to close.
pause >nul
exit /b 1
