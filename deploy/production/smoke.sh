#!/usr/bin/env bash
# @author masterzee001
#
# Probe every public route of an environment from the OUTSIDE, through
# Cloudflare and Caddy, the way a phone or a browser would. Exit non-zero if
# any expectation fails. Expected codes were read off staging on 30 Aug 2026
# with the same probes, so the two environments are held to one standard.
#
#   bash deploy/production/smoke.sh                # https://consummate7.com
#   bash deploy/production/smoke.sh staging        # https://staging.consummate7.com
#   ORIGIN=https://example.test bash deploy/production/smoke.sh
#
# Nothing here authenticates, posts, or prints a header value other than the
# CDN's name. TURN (UDP 3478 on the origin IP) is not an HTTP route and is not
# probed here; the runbook covers it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/env.sh
. "$HERE/../lib/env.sh"
videofy_env "${1:-production}"
ORIGIN="${ORIGIN:-$VIDEOFY_PUBLIC_ORIGIN}"

FAIL=0
probe() {
  local path="$1" want="$2" want_type="${3:-}"
  local out code ctype
  out="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 20 "$ORIGIN$path" 2>/dev/null || echo "000 none")"
  code="${out%% *}"; ctype="${out#* }"
  local ok="ok"
  [[ "$code" == "$want" ]] || ok="FAIL"
  if [[ -n "$want_type" && "$ctype" != "$want_type"* ]]; then ok="FAIL"; fi
  [[ "$ok" == "ok" ]] || FAIL=1
  printf '%-4s %-34s %s (want %s%s)\n' "$ok" "$path" "$code" "$want" "${want_type:+ $want_type}"
}

echo "smoke: $ORIGIN"
# Service health through the edge, on this environment's own upstreams.
probe /health                      200 application/json
probe /auth/health                 200 application/json
probe /media/health                200 application/json
# Static apps: the shell must come back as HTML, never a JSON 404.
probe /                            200 text/html
probe /operator/                   200 text/html
probe /listen/                     200 text/html
probe /call/                       200 text/html
probe /streams/x                   200 text/html
probe /join                        200 text/html
probe /videofy/live/               200 text/html
# Gateway and media routes a device asks before it is in a room.
probe /calls/x/status              200 application/json
probe /media/languages/catalogue   200 application/json
# The server-only prefix is refused at the edge, under every mount.
probe /internal/x                  404
probe /media/internal/x            404
probe /auth/internal/x             404

# Proxied, not grey-clouded: the CDN names itself. (Value is a product name.)
server="$(curl -sI --max-time 20 "$ORIGIN/health" | tr -d '\r' | awk -F': ' 'tolower($1)=="server"{print $2}')"
if [[ "$server" == "cloudflare" ]]; then
  echo "ok   edge: cloudflare"
else
  echo "warn edge: server header is '${server:-none}' (expected cloudflare once the record is proxied)"
fi

# The shell must revalidate every load; a shell with no Cache-Control is the
# bug that made deployed fixes invisible for hours.
cc="$(curl -sI --max-time 20 "$ORIGIN/operator/" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
if [[ "$cc" == *no-cache* ]]; then
  echo "ok   shell cache-control: $cc"
else
  echo "FAIL shell cache-control: '${cc:-none}' (want no-cache, must-revalidate)"; FAIL=1
fi

# The served shell must reference a bundle that exists (a --base mismatch
# renders a blank page that looks like an outage).
asset="$(curl -s --max-time 20 "$ORIGIN/operator/" | grep -o 'src="[^"]*\.js"' | head -1 | sed 's/src="//;s/"$//')"
if [[ -n "$asset" ]]; then
  case "$asset" in /*) asset_url="$ORIGIN$asset";; *) asset_url="$ORIGIN/operator/$asset";; esac
  probe "${asset_url#"$ORIGIN"}" 200 text/javascript
else
  echo "FAIL operator shell names no script bundle"; FAIL=1
fi

if [[ $FAIL -eq 0 ]]; then echo "SMOKE PASSED: $ORIGIN"; else echo "SMOKE FAILED: $ORIGIN"; fi
exit $FAIL
