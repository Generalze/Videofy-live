#!/usr/bin/env bash
# @author masterzee001
#
# Probe every LOCKED public route of an environment from the OUTSIDE, through
# Cloudflare and Caddy, the way a phone or a browser would. Exit non-zero if
# any expectation fails.
#
# FOUNDER RULING, LOCKED 30 Aug 2026: "Same-origin path architecture,
# mirroring staging: / (C7 site), /videofy/, /videofy/live/, /call/, /listen/,
# /streams/<handle>, /operator/, /auth/*, /media/*, /calls/*, /socket.io/*."
# Every one of those paths is probed BY NAME below, with the status and
# content type it must answer, plus /webrtc/* (the ICE route the call app
# needs) and the /internal/* refusal under every mount. A route list that is
# summarised rather than enumerated is a route list with a hole in it: this
# script is the enumeration.
#
# Expected codes were read off staging on 30 Aug 2026 with these exact probes,
# so the two environments are held to one standard.
#
#   bash deploy/production/smoke.sh                # https://consummate7.com
#   bash deploy/production/smoke.sh staging        # https://staging.consummate7.com
#   ORIGIN=https://example.test bash deploy/production/smoke.sh
#   SMOKE_CHANNEL_HANDLE=zoemeak bash deploy/production/smoke.sh
#
# Nothing here authenticates, posts, or prints a header value other than the
# CDN's name. The relay is not an HTTP route, but the HOST the gateway hands
# to browsers is readable from /webrtc/ice, and it IS checked here -- see the
# TURN section at the end.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/env.sh
. "$HERE/../lib/env.sh"
# shellcheck source=../lib/turn-guard.sh
. "$HERE/../lib/turn-guard.sh"
videofy_env "${1:-production}"
ORIGIN="${ORIGIN:-$VIDEOFY_PUBLIC_ORIGIN}"

# A handle that exists, for the canonical-page data probe. Any handle serves
# the SHELL (Caddy rewrites /streams/* to index.html), so the shell probe uses
# a fixed literal; only the /auth lookup needs a real one.
CHANNEL_HANDLE="${SMOKE_CHANNEL_HANDLE:-}"
# A handle nobody can have claimed: the 404 side of the same route.
UNKNOWN_HANDLE="smoke-no-such-handle-000"

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
  printf '%-4s %-42s %s (want %s%s)\n' "$ok" "$path" "$code" "$want" "${want_type:+ $want_type}"
}

echo "smoke: $ORIGIN"

echo "-- locked static routes (the C7 site and the four apps, same origin) --"
probe /                                       200 text/html
probe /videofy/                               200 text/html
probe /videofy/live/                          200 text/html
probe /call/                                  200 text/html
probe /listen/                                200 text/html
probe /operator/                              200 text/html
# /streams/<handle> is the public canonical channel page: the listener bundle,
# reached by handle. The SHELL must be HTML for ANY handle -- a JSON 404 here
# means the rewrite is missing and every shared channel link is dead.
probe "/streams/$UNKNOWN_HANDLE"              200 text/html
[[ -n "$CHANNEL_HANDLE" ]] && probe "/streams/$CHANNEL_HANDLE" 200 text/html

echo "-- locked service routes --"
probe /health                                 200 application/json
probe /auth/health                            200 application/json
probe /media/health                           200 application/json
# The direct-call telephone: asked BEFORE a device is in a socket room.
probe /calls/x/status                         200 application/json
# ICE servers (STUN, and TURN when a relay is configured) for call video.
probe /webrtc/ice                             200 application/json
# The realtime gateway's own handshake, through the edge.
probe "/socket.io/?EIO=4&transport=polling"   200 text/plain
probe /media/languages/catalogue              200 application/json

echo "-- /streams/<handle> DATA through /auth (the canonical channel lookup) --"
# The shell is static and answers for anything; the DATA behind it must tell
# an existing handle from a missing one. Both sides are probed, because a
# lookup that answers 200 for everything is exactly as broken as one that
# answers 404 for everything, and the shell probe cannot see either.
probe "/auth/streams/$UNKNOWN_HANDLE"         404 application/json
if [[ -n "$CHANNEL_HANDLE" ]]; then
  probe "/auth/streams/$CHANNEL_HANDLE"       200 application/json
else
  echo "note /auth/streams/<existing>: not probed (set SMOKE_CHANNEL_HANDLE=<handle> after the first channel exists)"
fi

echo "-- the server-only prefix is refused at the edge, under every mount --"
probe /internal/x                             404
probe /media/internal/x                       404
probe /auth/internal/x                        404

echo "-- edge, canonical host and cache --"
# Proxied, not grey-clouded: the CDN names itself. (Value is a product name.)
server="$(curl -sI --max-time 20 "$ORIGIN/health" | tr -d '\r' | awk -F': ' 'tolower($1)=="server"{print $2}')"
if [[ "$server" == "cloudflare" ]]; then
  echo "ok   edge: cloudflare"
else
  echo "warn edge: server header is '${server:-none}' (expected cloudflare once the record is proxied)"
fi

# ONE canonical host. www exists only to send people to the apex; a www that
# serves the app is a second origin, and a session cookie set on one is not
# sent to the other.
if [[ "$VIDEOFY_ENV" == "production" ]]; then
  redir="$(curl -sI --max-time 20 "https://www.$VIDEOFY_PUBLIC_HOST/" | tr -d '\r')"
  rcode="$(printf '%s' "$redir" | awk 'NR==1{print $2}')"
  rloc="$(printf '%s' "$redir" | awk -F': ' 'tolower($1)=="location"{print $2}')"
  if [[ "$rcode" == "301" || "$rcode" == "308" ]] && [[ "$rloc" == "$VIDEOFY_PUBLIC_ORIGIN"* ]]; then
    echo "ok   www.$VIDEOFY_PUBLIC_HOST -> $rcode $rloc"
  else
    echo "FAIL www.$VIDEOFY_PUBLIC_HOST: '${rcode:-none}' to '${rloc:-none}' (want 301/308 to $VIDEOFY_PUBLIC_ORIGIN)"; FAIL=1
  fi
fi

# The shell must revalidate every load; a shell with no Cache-Control is the
# bug that made deployed fixes invisible for hours.
for shell in /operator/ /listen/ /call/ /; do
  cc="$(curl -sI --max-time 20 "$ORIGIN$shell" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
  if [[ "$cc" == *no-cache* ]]; then
    echo "ok   shell cache-control $shell: $cc"
  else
    echo "FAIL shell cache-control $shell: '${cc:-none}' (want no-cache, must-revalidate)"; FAIL=1
  fi
done

# The served shell must reference a bundle that exists (a --base mismatch
# renders a blank page that looks like an outage).
for app in operator listen call; do
  asset="$(curl -s --max-time 20 "$ORIGIN/$app/" | grep -o 'src="[^"]*\.js"' | head -1 | sed 's/src="//;s/"$//')"
  if [[ -n "$asset" ]]; then
    case "$asset" in /*) asset_url="$asset";; *) asset_url="/$app/$asset";; esac
    probe "$asset_url" 200 text/javascript
  else
    echo "FAIL /$app/ shell names no script bundle"; FAIL=1
  fi
done

echo "-- TURN: never behind the ordinary Cloudflare proxy --"
# The gateway's ICE response is the ONLY place the configured relay host is
# observable from outside, and it is the exact string browsers dial. Only the
# host is extracted; the response also carries a minted credential and that is
# never read, printed or stored here.
ice="$(curl -s --max-time 20 "$ORIGIN/webrtc/ice" 2>/dev/null || true)"
turn_host="$(printf '%s' "$ice" | grep -oE '"turns?:[^":?]+' | head -1 | sed 's/.*://')"
if [[ -z "$turn_host" ]]; then
  echo "warn no TURN server in /webrtc/ice (relay not configured: cross-NAT calls will fail)"
else
  if videofy_turn_guard "$turn_host" "relay host from /webrtc/ice"; then :; else FAIL=1; fi
fi

if [[ $FAIL -eq 0 ]]; then echo "SMOKE PASSED: $ORIGIN"; else echo "SMOKE FAILED: $ORIGIN"; fi
exit $FAIL
