#!/usr/bin/env bash
#
# Build the single-page apps and stage them where Caddy serves from.
#
# Every base URL here is RELATIVE. Nothing bakes in a hostname, so these bundles
# stay correct when the domain changes -- a bundle with an absolute origin
# compiled into it must be rebuilt the day DNS moves, and that rebuild is always
# remembered one incident too late.
#
# Run from the repository root, after `npm ci && npm run build`.
set -euo pipefail

WWW_DIR="${WWW_DIR:-/srv/videofy/www}"

# Same origin as the page itself. `/` is the socket.io default namespace.
export VITE_GATEWAY_URL=/
export VITE_CALL_PATH=/call/       # where the C7 site sends "Launch Live"
export VITE_ACCOUNT_URL=/auth
export VITE_INGEST_URL=/media
export VITE_PROGRESSIVE_TRANSLATED_AUDIO=true

# Where the VIEWER app is served, as a PATH -- see the note above about
# hostnames. The operator console turns this into an absolute link at runtime
# using the origin of the page it is on, because that link gets copied out of
# the console and sent to somebody, and a relative path is useless to them.
export VITE_VIEWER_BASE=/listen

# ICE servers for the BROWSER side, as JSON -- the client parses this with
# JSON.parse and returns [] on any failure, so a comma-separated list is
# silently identical to setting nothing at all.
#
# Public STUN only. A browser behind carrier NAT needs a reflexive
# candidate; without one it offers a private address and the server has
# nowhere to send audio. TURN is a separate decision (see the readiness
# doc) and is required for networks that block UDP outright.
export VITE_WEBRTC_ICE_SERVERS='[{"urls":["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"]}]'

build_app() {
  local app="$1" base="$2"
  echo "--- $app (base $base) ---"
  # --base must match the path Caddy serves the app from, or every asset URL in
  # index.html points somewhere that does not exist.
  npx vite build "apps/$app" --base="$base" --outDir dist-staging --emptyOutDir
  rm -rf "${WWW_DIR:?}/$app"
  mkdir -p "$WWW_DIR/$app"
  cp -r "apps/$app/dist-staging/." "$WWW_DIR/$app/"
  echo "  -> $WWW_DIR/$app"
}

# The C7 ecosystem site owns the root. Videofy is a product within it.
build_app ecosystem-web /

# Crawler-readable metadata per public route. WhatsApp and friends read the
# HTML without running JavaScript, so a client-side title is invisible to them.
# The origin is supplied here rather than compiled into the app: og:url and
# og:image must be absolute, and a hostname in the source follows the code
# everywhere it is ever deployed.
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://staging.consummate7.com}"
node scripts/generate-route-html.mjs "apps/ecosystem-web/dist-staging" "$PUBLIC_ORIGIN"
rm -rf "${WWW_DIR:?}/ecosystem-web"
mkdir -p "$WWW_DIR/ecosystem-web"
cp -r apps/ecosystem-web/dist-staging/. "$WWW_DIR/ecosystem-web/"
build_app call-web /call/
build_app listener-web /listen/
build_app operator-web /operator/
echo "apps staged into $WWW_DIR"
