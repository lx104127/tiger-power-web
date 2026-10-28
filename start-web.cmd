@echo off
chcp 65001 >nul
cd /d "%~dp0"
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<24||(major===24&&minor<7))process.exit(1)"
if errorlevel 1 (
  echo Please install Node.js 24.7 or newer from https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules\@binance\agentic-wallet\package.json (
  call npm ci --omit=dev
  if errorlevel 1 (pause & exit /b 1)
)
node scripts/start-web.mjs
pause
