@echo off
setlocal
cd /d "%~dp0"

echo.
echo   Preparing EffectCraft for Snapgent...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-config.ps1"
if errorlevel 1 goto failed

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-effectcraft.ps1"
if errorlevel 1 goto failed

echo.
echo   EffectCraft setup finished. Review the messages above for its connection status.
echo   Run start.bat to start or restart the bridge and connect to EffectCraft.
echo.
pause
exit /b 0

:failed
echo.
echo   EffectCraft setup failed. Review the error above, then try again.
echo.
pause
exit /b 1
