#!/usr/bin/env bash
# @author masterzee001
#
# Build the four web apps and stage them into an environment's web root, ON
# THE BOX. Generalised from scripts/stage-webapps.sh (the atomic .new/.old
# swap, o+rX so Caddy can read) and deploy/staging/build-apps.sh (the Open
# Graph route stamping), which between them held everything a correct staging
# needed and each held half.
#
#   WWW_DIR         where Caddy serves this environment from (required)
#   PUBLIC_ORIGIN   absolute scheme://host, stamped into og:url / og:image
#                   for the crawler-readable route files (required)
#
# THE BASE FLAG IS THE WHOLE REASON THIS SCRIPT EXISTS. Each app is served
# under a path prefix that Caddy strips, so each build must bake that prefix
# into its asset URLs; a build without it emits /assets/..., which resolves
# against the ecosystem site, 404s, and renders as a blank page that looks like
# an outage. Rediscovered twice in one day when the flags lived in shell
# history.
#
# Every URL the apps call is RELATIVE (/auth, /media, /socket.io), so nothing
# here bakes a hostname into a bundle; PUBLIC_ORIGIN reaches only the static
# metadata files, which is the one place an absolute URL is unavoidable.
#
# THE PER-CHANNEL PAGE IS NOT STAMPED HERE. /streams/<handle> carries a
# different title and picture for every channel, so no static file can serve
# it; the account service renders it, injecting the channel's identity into the
# listener shell this script stages (services/account/src/share-routes.ts). That
# service reads the shell from LISTENER_SHELL_PATH, which must name the
# listener-web/index.html this script writes into $WWW_DIR.
set -euo pipefail

WWW_DIR="${WWW_DIR:?WWW_DIR is required (e.g. /srv/videofy-prod/www)}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:?PUBLIC_ORIGIN is required (e.g. https://consummate7.com)}"
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Public STUN only, as JSON. The client JSON.parses this and returns [] on any
# failure, so a comma-separated list is silently identical to nothing at all.
# TURN is issued at runtime by the gateway (/webrtc/ice-servers) and is never
# compiled into a bundle.
export VITE_WEBRTC_ICE_SERVERS='[{"urls":["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"]}]'

stage() {
  local app="$1" base="$2" target="$3"
  if [ -n "$base" ]; then
    npx vite build --base="$base" --config "apps/$app/vite.config.ts" "apps/$app" >/dev/null
  else
    npm run build -w "apps/$app" >/dev/null
  fi
  # Crawler-readable <title> and og:* for EVERY app. WhatsApp reads the HTML
  # without running JavaScript, so a client-side title is invisible to it.
  #
  # THIS RAN FOR ecosystem-web ALONE, and that omission was the bug: /, /videofy/
  # and /videofy/live/ previewed correctly while /call/, /listen/ and /operator/
  # -- the three actual product surfaces -- went out with a bare <title>, no
  # og:image and no og:url, and shared as naked URLs. The ecosystem site stamps
  # one file per public route from its own table; every other app stamps its own
  # single shell, taking the words from that app's index.html.
  if [ "$app" = "ecosystem-web" ]; then
    node scripts/generate-route-html.mjs "apps/$app/dist" "$PUBLIC_ORIGIN"
  else
    node scripts/generate-route-html.mjs "apps/$app/dist" "$PUBLIC_ORIGIN" --app "$base"
  fi
  rm -rf "$WWW_DIR/$target.new"
  cp -r "apps/$app/dist" "$WWW_DIR/$target.new"
  # Caddy is not in the deploy user's group; without o+rX every request 403s.
  chmod -R o+rX "$WWW_DIR/$target.new"
  rm -rf "$WWW_DIR/$target.old"
  if [ -d "$WWW_DIR/$target" ]; then
    mv "$WWW_DIR/$target" "$WWW_DIR/$target.old"
  fi
  mv "$WWW_DIR/$target.new" "$WWW_DIR/$target"
  echo "staged $app -> $WWW_DIR/$target (base: ${base:-/})"
}

mkdir -p "$WWW_DIR"
# ecosystem-web owns the root; every other app carries its prefix.
stage ecosystem-web ""           ecosystem-web
stage call-web      "/call/"     call-web
stage listener-web  "/listen/"   listener-web
stage operator-web  "/operator/" operator-web
echo "apps staged into $WWW_DIR for $PUBLIC_ORIGIN"
