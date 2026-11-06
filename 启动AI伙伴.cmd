@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-companion.ps1"
echo.
echo Window can be closed now.
pause
