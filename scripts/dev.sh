#!/usr/bin/env bash
# Videofy Live – start all development services
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT/services/speech-worker/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "Python virtual environment is missing."
  echo "Run:"
  echo "  cd services/speech-worker"
  echo "  python3 -m venv .venv"
  echo "  . .venv/bin/activate"
  echo "  pip install -e '.[dev]'"
  exit 1
fi

cd "$ROOT"

cleanup() {
  jobs -p | xargs -r kill
}
trap cleanup EXIT INT TERM

if command -v concurrently >/dev/null 2>&1; then
  concurrently \
    -n "gateway,ingest,listener,operator,worker" \
    -c "cyan,yellow,green,magenta,blue" \
    "npm run dev -w services/realtime-gateway" \
    "npm run dev -w services/media-ingest" \
    "npm run dev -w apps/listener-web" \
    "npm run dev -w apps/operator-web" \
    "cd services/speech-worker && .venv/bin/python main.py"
else
  npm run dev -w services/realtime-gateway &
  npm run dev -w services/media-ingest &
  npm run dev -w apps/listener-web &
  npm run dev -w apps/operator-web &
  (cd services/speech-worker && .venv/bin/python main.py) &
  echo "Listener App      http://localhost:5173"
  echo "Operator App      http://localhost:5174"
  echo "Realtime Gateway  http://localhost:3001"
  echo "Media Ingest      http://localhost:3002/health"
  echo "Speech Worker     http://localhost:8001/health"
  wait
fi
