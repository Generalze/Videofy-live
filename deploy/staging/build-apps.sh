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
export VITE_ACCOUNT_URL=/auth
export VITE_INGEST_URL=/media
export VITE_PROGRESSIVE_TRANSLATED_AUDIO=true

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

build_app call-web /
build_app listener-web /listen/
build_app operator-web /operator/
echo "apps staged into $WWW_DIR"
