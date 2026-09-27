@echo off
rem Double-click to run Deafference Motion Studio in your browser (this computer only).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
if errorlevel 1 pause
