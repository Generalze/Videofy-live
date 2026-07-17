#!/usr/bin/env bash
# Videofy Live - start all development services
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT/services/speech-worker/.venv/bin/python"
LOG_DIR="$ROOT/.videofy-dev-logs"
GATEWAY_HEALTH_URL="http://localhost:3001/health"
READINESS_TIMEOUT_SECONDS=45

declare -a SERVICE_NAMES=()
declare -a SERVICE_PIDS=()

if [[ ! -x "$PYTHON" ]]; then
  echo "Python virtual environment is missing."
  echo "Run:"
  echo "  cd services/speech-worker"
  echo "  python3 -m venv .venv"
  echo "  . .venv/bin/activate"
  echo "  pip install -e '.[dev]'"
  exit 1
fi

mkdir -p "$LOG_DIR"
cd "$ROOT"

export VITE_SOCKET_TRANSPORT="${VITE_SOCKET_TRANSPORT:-polling}"

cleanup() {
  for ((i=${#SERVICE_PIDS[@]} - 1; i>=0; i--)); do
    local pid="${SERVICE_PIDS[$i]}"
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "Stopping ${SERVICE_NAMES[$i]} (PID $pid)..."
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  wait >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

start_service() {
  local name="$1"
  local workdir="$2"
  shift 2
  local safe_name
  safe_name="$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  local stdout="$LOG_DIR/${safe_name}.stdout.log"
  local stderr="$LOG_DIR/${safe_name}.stderr.log"

  echo "Starting $name..."
  (
    cd "$workdir"
    "$@"
  ) >"$stdout" 2>"$stderr" &

  local pid=$!
  SERVICE_NAMES+=("$name")
  SERVICE_PIDS+=("$pid")
  echo "  $name PID $pid"
  echo "  logs: $stdout / $stderr"
}

print_log_tail() {
  local name="$1"
  local safe_name
  safe_name="$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  echo
  echo "$name failed. Last log lines:"
  for path in "$LOG_DIR/${safe_name}.stderr.log" "$LOG_DIR/${safe_name}.stdout.log"; do
    if [[ -f "$path" ]]; then
      echo "--- $path ---"
      tail -n 40 "$path"
    fi
  done
}

wait_for_gateway() {
  local deadline=$((SECONDS + READINESS_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if ! kill -0 "${SERVICE_PIDS[0]}" >/dev/null 2>&1; then
      print_log_tail "Realtime Gateway"
      echo "Realtime Gateway exited before becoming healthy."
      exit 1
    fi
    if curl -fsS "$GATEWAY_HEALTH_URL" >/dev/null 2>&1; then
      echo "Realtime Gateway is healthy."
      return
    fi
    sleep 0.5
  done
  echo "Timed out waiting $READINESS_TIMEOUT_SECONDS seconds for $GATEWAY_HEALTH_URL"
  exit 1
}

watch_services() {
  while true; do
    sleep 1
    for i in "${!SERVICE_PIDS[@]}"; do
      local pid="${SERVICE_PIDS[$i]}"
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        local status=0
        wait "$pid" || status=$?
        print_log_tail "${SERVICE_NAMES[$i]}"
        echo "Development service exited: ${SERVICE_NAMES[$i]} (PID $pid, exit code $status)"
        exit 1
      fi
    done
  done
}

echo "Starting Videofy Live development services..."
echo "Logs: $LOG_DIR"
echo "Browser Socket.IO transport: $VITE_SOCKET_TRANSPORT"

start_service "Realtime Gateway" "$ROOT" npm run dev -w services/realtime-gateway
wait_for_gateway
start_service "Media Ingest" "$ROOT" npm run dev -w services/media-ingest
start_service "Listener App" "$ROOT" npm run dev -w apps/listener-web
start_service "Operator App" "$ROOT" npm run dev -w apps/operator-web
start_service "Speech Worker" "$ROOT/services/speech-worker" "$PYTHON" main.py

echo
echo "Services started. Press Ctrl+C to stop all child processes."
echo "  Realtime Gateway  http://localhost:3001/health"
echo "  Media Ingest      http://localhost:3002/health"
echo "  Listener App      http://localhost:5173"
echo "  Operator App      http://localhost:5174"
echo "  Speech Worker     http://localhost:8001/health"

watch_services
