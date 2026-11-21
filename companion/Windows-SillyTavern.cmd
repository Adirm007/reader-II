@echo off
cd /d "%~dp0"
where node.exe >nul 2>nul || (
  echo Install Node.js LTS from https://nodejs.org/en/download and run this file again.
  pause
  exit /b 1
)
node setup.mjs windows
pause
