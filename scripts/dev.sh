#!/usr/bin/env bash
# Videofy Live – start all development services
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v concurrently >/dev/null 2>&1; then
  concurrently \
    -n "gateway,ingest,listener,operator" \
    -c "cyan,yellow,green,magenta" \
    "npm run dev -w services/realtime-gateway" \
    "npm run dev -w services/media-ingest" \
    "npm run dev -w apps/listener-web" \
    "npm run dev -w apps/operator-web"
else
  npm run dev -w services/realtime-gateway &
  npm run dev -w services/media-ingest &
  npm run dev -w apps/listener-web &
  npm run dev -w apps/operator-web &
  wait
fi
