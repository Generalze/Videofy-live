#!/usr/bin/env bash
# @author masterzee001
#
# Build and stage the web apps into /srv/videofy/www — ON THE STAGING BOX.
#
# THE BASE FLAG IS THE WHOLE REASON THIS SCRIPT EXISTS. Each app is served
# under a path prefix (Caddy strips it before hitting the app's own root), so
# each build must bake that prefix into its asset URLs. A build without it
# emits /assets/... , which Caddy resolves against the ECOSYSTEM site, 404s,
# falls back to the SPA shell, and the browser refuses HTML where a module
# was promised: a blank page that looks like a server outage. This has now
# been rediscovered twice — operator and call on the same day — because the
# flags lived only in shell history.
#
# Permissions matter too: Caddy is not in the deploy user's group, so staged
# trees need o+rX or every request 403s.
set -euo pipefail
cd "$(dirname "$0")/.."

stage() {
  local app="$1" base="$2" target="$3"
  if [ -n "$base" ]; then
    npx vite build --base="$base" --config "apps/$app/vite.config.ts" "apps/$app" >/dev/null
  else
    npm run build -w "apps/$app" >/dev/null
  fi
  if [ "$app" = "ecosystem-web" ]; then
    # Crawler-readable <title> and og:* per public route (WhatsApp reads the HTML
    # without running JavaScript). Acceptance D1, 30 Aug: this step was only in
    # build-apps.sh, so a deploy through this script shipped a bundle with no cards.
    node scripts/generate-route-html.mjs "apps/$app/dist" "${PUBLIC_ORIGIN:-https://staging.consummate7.com}"
  fi
  rm -rf "/srv/videofy/www/$target.new"
  cp -r "apps/$app/dist" "/srv/videofy/www/$target.new"
  chmod -R o+rX "/srv/videofy/www/$target.new"
  rm -rf "/srv/videofy/www/$target.old"
  if [ -d "/srv/videofy/www/$target" ]; then
    mv "/srv/videofy/www/$target" "/srv/videofy/www/$target.old"
  fi
  mv "/srv/videofy/www/$target.new" "/srv/videofy/www/$target"
  echo "staged $app -> /srv/videofy/www/$target (base: ${base:-/})"
}

# ecosystem-web owns the root; every other app carries its prefix.
stage ecosystem-web ""          ecosystem-web
stage call-web      "/call/"    call-web
stage listener-web  "/listen/"  listener-web
stage operator-web  "/operator/" operator-web
