#!/usr/bin/env bash
# Stage TranslateGemma 4B into the BENCHMARK runtime, never production.
#
# Founder approved accepting the Gemma gate for EVALUATION ONLY (31 Aug 2026).
# That approval does not extend to the production message path, and this script
# is deliberately incapable of touching it: it writes to
# /var/lib/videofy/bench/ and never to /opt/videofy-ai.
#
# THE TOKEN NEVER APPEARS IN AN ARGUMENT. It is read from the environment file
# where set-env-key.sh put it, so it is not in this script, not in the remote
# process list, and not in anybody's shell history. Nothing here echoes it, and
# the only thing printed about it is whether it is present.
#
#   1. Founder accepts the terms at huggingface.co/google/translategemma-4b-it
#      on an account C7 CONTROLS -- access follows the account, and so does
#      termination.
#   2. Founder stores the read token:
#        .\deploy\Set-EnvKey.ps1 -Name HF_TOKEN -EnvFile /etc/videofy/bench.env
#   3. bash scripts/stage-translategemma.sh
set -euo pipefail

MODEL="google/translategemma-4b-it"
BENCH_DIR="/var/lib/videofy/bench"
VENV="${BENCH_DIR}/gemma-venv"
CACHE="/var/lib/videofy/models"
ENV_FILE="/etc/videofy/bench.env"

if ! sudo -n test -f "$ENV_FILE"; then
  echo "refusing: $ENV_FILE does not exist." >&2
  echo "  Store the token first:" >&2
  echo "    .\\deploy\\Set-EnvKey.ps1 -Name HF_TOKEN -EnvFile $ENV_FILE" >&2
  exit 2
fi

if ! sudo -n grep -q '^HF_TOKEN=' "$ENV_FILE"; then
  echo "refusing: HF_TOKEN is not set in $ENV_FILE." >&2
  exit 2
fi
echo "HF_TOKEN present (value not read, not displayed)"

# A runtime of its own. TranslateGemma is a Gemma 3 derivative and wants a
# NEWER transformers than the MADLAD venv is pinned to, so the two must not
# share -- and neither may borrow production's.
if [ ! -x "${VENV}/bin/python" ]; then
  echo "creating ${VENV}"
  sudo -n python3 -m venv "$VENV"
  sudo -n "${VENV}/bin/pip" -q install --upgrade pip
  sudo -n "${VENV}/bin/pip" -q install \
    torch==2.4.1 --index-url https://download.pytorch.org/whl/cpu
  sudo -n "${VENV}/bin/pip" -q install \
    'transformers>=4.50' sentencepiece protobuf accelerate 'huggingface_hub>=0.26'
fi

sudo -n "${VENV}/bin/python" - <<'PY'
import json, os, sys

# The token reaches the process through the environment and is never printed.
tok = os.environ.get("HF_TOKEN", "")
if not tok:
    print("refusing: HF_TOKEN empty in this process", file=sys.stderr)
    raise SystemExit(2)

from huggingface_hub import snapshot_download

path = snapshot_download(
    "google/translategemma-4b-it",
    token=tok,
    allow_patterns=["*.json", "*.model", "*.safetensors", "*.txt", "*.jinja"],
)
print("staged:", path)

# THE QUESTION THE GATE WAS HIDING. The authoritative language list lives in
# the chat template, and until now it answered 401. Print what is actually
# there -- no inference from model-card prose, per directive.
import pathlib, re
tpl = pathlib.Path(path) / "chat_template.jinja"
if tpl.exists():
    text = tpl.read_text(encoding="utf-8", errors="replace")
    codes = sorted(set(re.findall(r"['\"]([a-z]{2,3}(?:-[A-Za-z]{2,4})?)['\"]", text)))
    print("\nlanguage codes present in chat_template.jinja:")
    print(" ", " ".join(codes) if codes else "(none found -- inspect by hand)")
    for want in ("yo", "ha", "ig", "pcm"):
        print(f"  {want:4s} {'PRESENT' if want in codes else 'ABSENT'}")
    print("\nPresence is NOT support. Support is established by translating.")
else:
    print("chat_template.jinja not in the snapshot -- inspect the repo by hand")
PY

echo
echo "Staged into the BENCHMARK runtime only. /opt/videofy-ai untouched."
echo "Next: controlled translations for yo/ha/ig/pcm before any screen."
