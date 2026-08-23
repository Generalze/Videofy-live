#!/usr/bin/env bash
#
# Install the local translation engine: a Python runtime for the OPUS-MT worker
# and the Marian models it loads.
#
# WHY LOCAL AND NOT A CLOUD API. Recognition and voice are commercial services
# billed per minute and per character; translation here is a set of small
# Marian models that run on the CPU this box already has. It costs nothing per
# call, works with no network round trip, and cannot start failing because a
# vendor changed a plan.
#
# WHY THE MODELS ARE FETCHED HERE RATHER THAN ON FIRST USE. A model downloaded
# during a live call makes the first sentence of somebody's conversation
# arrive a minute late, or not at all. They are pulled once, now, and the
# service is left with downloads DISABLED so a missing model is a loud failure
# at startup rather than a silent stall mid-call.
set -euo pipefail

VENV=/opt/videofy-ai
CACHE=/var/lib/videofy/models
SERVICE_USER=videofy
ENV_FILE=/etc/videofy/media-ingest.env

MODELS=(
  Helsinki-NLP/opus-mt-en-fr
  Helsinki-NLP/opus-mt-fr-en
  Helsinki-NLP/opus-mt-en-es
  Helsinki-NLP/opus-mt-en-ROMANCE
  Helsinki-NLP/opus-mt-es-en
)

echo "--- system packages ---"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip >/dev/null

echo "--- python runtime at $VENV ---"
python3 -m venv "$VENV"
# CPU wheels only. The default index pulls the CUDA build: several gigabytes of
# GPU runtime that cannot be used on a box with no GPU.
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet --index-url https://download.pytorch.org/whl/cpu torch
# sentencepiece is not optional for Marian: MarianTokenizer cannot load without
# it, and the failure surfaces as a confusing tokenizer error at first use.
# sacremoses is not optional in practice: without it MarianTokenizer warns and
# falls back to a weaker tokenizer, which quietly costs translation quality.
"$VENV/bin/pip" install --quiet transformers sentencepiece sacremoses

echo "--- model cache at $CACHE ---"
install -d -m 0755 "$CACHE"

echo "--- fetching ${#MODELS[@]} models (once) ---"
HF_HOME="$CACHE" "$VENV/bin/python" - "$CACHE" "${MODELS[@]}" <<'PY'
import sys
from transformers import MarianMTModel, MarianTokenizer

cache = sys.argv[1]
failed = []
for model_id in sys.argv[2:]:
    try:
        MarianTokenizer.from_pretrained(model_id, cache_dir=cache)
        MarianMTModel.from_pretrained(model_id, cache_dir=cache)
        print(f"  ok    {model_id}")
    except Exception as error:                      # noqa: BLE001
        failed.append(model_id)
        print(f"  FAIL  {model_id}: {error}")

if failed:
    # Half a translation engine is not a translation engine: the pairs that
    # did download would work and the rest would fail mid-call, which is
    # harder to diagnose than nothing working at all.
    print(f"\n{len(failed)} model(s) did not download: {', '.join(failed)}")
    sys.exit(1)
PY

# The service reads these as the user below, not as root.
chown -R "$SERVICE_USER:$SERVICE_USER" "$CACHE"

echo "--- pointing media-ingest at them ---"
# Replace rather than append, for the same reason the credential script does:
# a second definition of a key lets the older one win depending on read order.
# Never append onto an unterminated last line: doing so once produced
# `TRANSLATION_PROVIDER=opus-mtOPUS_MT_PYTHON=...` and crash-looped the service.
if [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ]; then
  printf '
' >> "$ENV_FILE"
fi

for line in \
  "OPUS_MT_PYTHON=$VENV/bin/python" \
  "OPUS_MT_MODEL_CACHE_DIR=$CACHE" \
  "OPUS_MT_ALLOW_MODEL_DOWNLOAD=false" \
  "AI_PYTHON_EXECUTABLE=$VENV/bin/python"
do
  key="${line%%=*}"
  sed -i "/^${key}=/d" "$ENV_FILE"
  printf '%s\n' "$line" >> "$ENV_FILE"
done
chown root:root "$ENV_FILE"
chmod 640 "$ENV_FILE"

systemctl restart videofy-media-ingest
for _ in $(seq 1 40); do
  curl -fsS -o /dev/null http://127.0.0.1:3002/health && break
  sleep 1
done

echo "--- result ---"
systemctl is-active videofy-media-ingest
curl -fsS http://127.0.0.1:3002/health | python3 -c "
import sys, json
d = json.load(sys.stdin)
e = d.get('translationEngine', {})
print('  engine real   :', e.get('real'))
print('  translation   :', e.get('translation'))
pairs = d.get('unavailableTranslationPairs') or []
print('  unavailable pairs:', len(pairs))
for p in pairs[:6]:
    print('   -', p.get('pair'), '::', p.get('reason'))
"
