#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major<24 || (major===24 && minor<7)) { console.error("Please install Node.js 24.7 or newer: https://nodejs.org"); process.exit(1); }'
if [[ ! -f node_modules/@binance/agentic-wallet/package.json ]]; then
  npm ci --omit=dev
fi
exec node scripts/start-web.mjs
