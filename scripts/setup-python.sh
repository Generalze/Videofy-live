#!/usr/bin/env bash
# Set up the Python speech worker virtual environment
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT/services/speech-worker"

echo "Setting up Python environment for speech-worker..."
cd "$WORKER_DIR"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e ".[dev]"
echo "Python environment ready."
echo "Activate with: source services/speech-worker/.venv/bin/activate"
