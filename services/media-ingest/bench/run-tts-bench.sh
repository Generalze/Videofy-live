#!/usr/bin/env bash
#
# Measure the TTS providers against the real vendors, on the box where the
# credentials live.
#
# Credentials are read straight into the environment of the node process and
# never echoed. The script is copied into the app tree because Node resolves
# node_modules from the script's own location.
set -euo pipefail

APP=/srv/videofy/app
RUNNER="$APP/.tts-bench.mjs"
cleanup() { rm -f "$RUNNER"; }
trap cleanup EXIT

cp /tmp/tts-bench.mjs "$RUNNER"
cd "$APP"

echo "=== which TTS credentials this deployment has (names only) ==="
sudo sed -n 's/^\(ELEVENLABS[A-Z_]*\|AZURE[A-Z_]*\)=.\+/  \1 present/p' /etc/videofy/media-ingest.env || true
echo

# Only the four variables the benchmark needs, pulled one at a time so nothing
# else from that file enters this process.
ELEVENLABS_API_KEY="$(sudo sed -n 's/^ELEVENLABS_API_KEY=//p' /etc/videofy/media-ingest.env)" \
ELEVENLABS_DEFAULT_VOICE_ID="$(sudo sed -n 's/^ELEVENLABS_DEFAULT_VOICE_ID=//p' /etc/videofy/media-ingest.env)" \
ELEVENLABS_MODEL="$(sudo sed -n 's/^ELEVENLABS_MODEL=//p' /etc/videofy/media-ingest.env)" \
AZURE_SPEECH_KEY="$(sudo sed -n 's/^AZURE_SPEECH_KEY=//p' /etc/videofy/media-ingest.env)" \
AZURE_SPEECH_REGION="$(sudo sed -n 's/^AZURE_SPEECH_REGION=//p' /etc/videofy/media-ingest.env)" \
AZURE_DEFAULT_VOICE_ID="$(sudo sed -n 's/^AZURE_DEFAULT_VOICE_ID=//p' /etc/videofy/media-ingest.env)" \
BENCH_RUNS="${BENCH_RUNS:-3}" \
  node "$RUNNER"
