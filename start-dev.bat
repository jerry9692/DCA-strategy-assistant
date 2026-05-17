@echo off
setlocal
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1" %*
pause
