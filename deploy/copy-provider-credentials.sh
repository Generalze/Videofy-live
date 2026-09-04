#!/usr/bin/env bash
# Copy the APPROVED provider credentials from one environment to another, on
# the box, without any value crossing a terminal, a log or a network hop it
# was not already on.
#
#   sudo bash deploy/copy-provider-credentials.sh /etc/videofy /etc/videofy-prod
#
# FOUNDER RULING 30 Aug 2026: "Reuse the existing staging provider credentials
# server-side. I do not authorize or require new production API keys. Transfer
# only the explicit provider credential/configuration whitelist into
# /etc/videofy-prod; never expose their values. Preserve all production
# runtime/profile/provider-selection guards and complete certification
# independently."
#
# WHY A WHITELIST AND NOT A COPY. Staging's media-ingest.env also carries
# `AI_RUNTIME_PROFILE=development-demo` and `TRANSCRIPTION_PROVIDER=mock`.
# Copying the file would carry a development posture into production under the
# cover of "the credentials work" -- which is exactly the mock-success path the
# founder forbade. Only the names below move; everything else in production
# stays independently configured.
#
# WHAT THIS DOES NOT DO: certify anything. A key that authenticates is not a
# provider that has been benchmarked, and the certification gate is untouched.
set -euo pipefail

FROM_DIR="${1:?usage: copy-provider-credentials.sh <from-env-dir> <to-env-dir>}"
TO_DIR="${2:?usage: copy-provider-credentials.sh <from-env-dir> <to-env-dir>}"

# The approved list, per the ruling. Anything not named here is not copied.
ACCOUNT_NAMES=""
INGEST_NAMES="
DEEPGRAM_API_KEY DEEPGRAM_MODEL
ELEVENLABS_API_KEY ELEVENLABS_DEFAULT_VOICE_ID ELEVENLABS_MODEL
AZURE_SPEECH_KEY AZURE_SPEECH_REGION AZURE_DEFAULT_VOICE_ID
GOOGLE_TRANSLATE_PROJECT_ID GOOGLE_CLOUD_QUOTA_PROJECT
NAIJALINGO_API_KEY NAIJALINGO_BASE_URL NAIJALINGO_MODEL
NAIJALINGO_AUTH_HEADER NAIJALINGO_AUTH_SCHEME
NAIJALINGO_VOICE_BY_LANGUAGE NAIJALINGO_VOICE_IDS NAIJALINGO_DEFAULT_VOICE
NAIJALINGO_RESPONSE_FORMAT NAIJALINGO_SAMPLE_RATE
"

# Never copied: the environment's own identity and posture.
FORBIDDEN="C7_ENVIRONMENT AI_RUNTIME_PROFILE TRANSCRIPTION_PROVIDER TRANSLATION_PROVIDER
DATABASE_URL INTERNAL_WEBRTC_TOKEN VIDEOFY_AUTH_SECRET CONNECT_AUTH_SECRET
CHANNEL_ID_SALT OPERATOR_CONSOLE_ACCOUNT_IDS PLATFORM_OPERATOR_ACCOUNT_IDS
C7_PUBLIC_ORIGIN GATEWAY_URL MEDIA_INGEST_URL ACCOUNT_SERVICE_URL PORT HOST"

copy_one() { # $1 file basename, $2 name
  local file="$1" name="$2" src="$FROM_DIR/$1" dst="$TO_DIR/$1"
  for bad in $FORBIDDEN; do
    [ "$name" = "$bad" ] && { echo "  REFUSED $name (environment posture, never copied)"; return 0; }
  done
  local value
  value="$(grep -E "^${name}=" "$src" 2>/dev/null | head -1 | cut -d= -f2-)" || true
  if [ -z "${value:-}" ]; then echo "  skip    $name (absent in $src)"; return 0; fi

  local action=replaced
  grep -qE "^${name}=" "$dst" || action=added
  local tmp
  tmp="$(mktemp "${dst}.XXXXXX")"
  chown --reference="$dst" "$tmp"; chmod --reference="$dst" "$tmp"
  grep -vE "^${name}=" "$dst" > "$tmp" || true
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  mv "$tmp" "$dst"
  echo "  $action $name (${#value} characters, value not displayed)"
}

echo "media-ingest.env:"
for n in $INGEST_NAMES; do copy_one media-ingest.env "$n"; done

if [ -n "${ACCOUNT_NAMES// /}" ]; then
  echo "account.env:"
  for n in $ACCOUNT_NAMES; do copy_one account.env "$n"; done
fi

# --- Google application credentials -----------------------------------------
# The credential IDENTITY is shared, the FILE is not: production must not
# depend on a file living under another environment's configuration, or
# tightening staging's permissions one day silently breaks production.
SRC_ADC="$(grep -E '^GOOGLE_APPLICATION_CREDENTIALS=' "$FROM_DIR/media-ingest.env" 2>/dev/null | head -1 | cut -d= -f2-)" || true
if [ -n "${SRC_ADC:-}" ] && [ -f "$SRC_ADC" ]; then
  DST_ADC="$TO_DIR/google-service-account.json"
  install -m 0640 -o root -g videofy "$SRC_ADC" "$DST_ADC"
  tmp="$(mktemp "$TO_DIR/media-ingest.env.XXXXXX")"
  chown --reference="$TO_DIR/media-ingest.env" "$tmp"; chmod --reference="$TO_DIR/media-ingest.env" "$tmp"
  grep -vE '^GOOGLE_APPLICATION_CREDENTIALS=' "$TO_DIR/media-ingest.env" > "$tmp" || true
  printf 'GOOGLE_APPLICATION_CREDENTIALS=%s\n' "$DST_ADC" >> "$tmp"
  mv "$tmp" "$TO_DIR/media-ingest.env"
  echo "  copied  Google service account -> $DST_ADC (0640 root:videofy, contents not displayed)"
else
  echo "  skip    Google service account (no GOOGLE_APPLICATION_CREDENTIALS file in $FROM_DIR)"
fi

echo "done. Provider credentials are shared; runtime posture, secrets and certification are not."
