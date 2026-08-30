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

# WHERE THE BROWSER SENDS ITS REQUESTS, compiled into every bundle.
#
# These are PATHS, not origins, because every surface is served from the one
# origin the page is already on -- which is also why the same values are right
# for staging and production and nothing here is per-environment.
#
# They were absent from this script for its first week, and the code's fallback
# is `http://localhost:3006`. So production shipped a site whose Join form
# posted to the visitor's own machine and reported "Could not reach C7 right
# now" -- a server that was answering 201 the whole time. The values had always
# been in deploy/staging/build-apps.sh; this script was generalised without
# them. The guard at the end of this file is what makes that unshippable rather
# than merely fixed.
export VITE_GATEWAY_URL=/
export VITE_CALL_PATH=/call/
export VITE_ACCOUNT_URL=/auth
export VITE_INGEST_URL=/media
export VITE_VIEWER_BASE=/listen
export VITE_PROGRESSIVE_TRANSLATED_AUDIO=true

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

# --- THE GUARD -------------------------------------------------------------
# Founder directive 30 Aug 2026, production smoke: "no public bundle contains
# localhost development endpoints". Checked HERE, on the files about to be
# served, because by the time a person sees "Could not reach C7" the evidence
# is a fetch that failed in their browser and the server looks healthy from
# every angle we can measure.
leaked=0
# -path pruning, not a plain find: `stage` keeps the previous release beside
# the new one as <app>.old so a bad deploy can be walked back, and those files
# legitimately carry whatever the last build did. Scanning them would refuse
# every deploy that follows a bad one -- including the one carrying the fix.
for f in $(find "$WWW_DIR" \( -name '*.old' -o -name '*.new' \) -prune -o -name '*.js' -type f -print 2>/dev/null); do
  if grep -qE 'localhost:[0-9]+|127\.0\.0\.1:[0-9]+' "$f"; then
    echo "REFUSED: $(basename "$f") names a development endpoint" >&2
    leaked=1
  fi
done
if [ "$leaked" -ne 0 ]; then
  echo "staging aborted: a bundle would have shipped pointing at a developer's machine" >&2
  exit 1
fi
echo "bundles carry no development endpoint"
