@echo off
setlocal
set SIM_AGENT_MODE=v2
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-companion.ps1"
echo.
echo Window can be closed now.
pause
endlocal
