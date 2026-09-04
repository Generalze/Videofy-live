#!/usr/bin/env bash
# @author masterzee001
#
# Refuse a TURN host that sits behind the ordinary Cloudflare proxy.
#
# FOUNDER RULING, LOCKED 30 Aug 2026: "TURN is NEVER behind the ordinary
# Cloudflare proxy: either the proven direct-origin arrangement
# (169.58.215.77) or an optional DNS-only turn.consummate7.com A record."
#
# WHY A SCRIPT AND NOT A COMMENT. The failure is silent and expensive: TURN is
# UDP 3478 (and TCP 3478), the ordinary Cloudflare proxy carries HTTP only, so
# a proxied hostname in TURN_HOST resolves, issues credentials, hands the
# browser a relay URL that answers nothing, and every cross-NAT call pays the
# full ICE timeout before failing. Nothing logs an error. `relayConfigured` is
# still true. The only symptom is "calls do not connect on mobile data", which
# is also the symptom of ten other things. A comment in an env template cannot
# catch a hostname somebody pastes at 2am; a check that runs on install and on
# every smoke can.
#
# HOW THE GATEWAY READS IT (services/realtime-gateway/src/ice-credentials.ts,
# readTurnConfig): TURN_HOST is used verbatim as the host part of
# `turn:<host>:<port>?transport=udp|tcp`. It is never resolved, validated or
# compared against anything. A host with no secret (or the reverse) yields NO
# relay rather than a broken one -- but a WRONG host with a good secret yields
# a relay broken in exactly the way described above. That asymmetry is what
# this guard exists to close.
#
#   . deploy/lib/turn-guard.sh
#   videofy_turn_guard <host-or-ip> [label]
#
# Exit status: 0 approved, 1 REFUSED (proxied or unverifiable), 2 not set.
# Prints names and addresses only; no secret is read or reachable here.

# Cloudflare's published IPv4 ranges (https://www.cloudflare.com/ips-v4).
# Embedded rather than fetched: this guard must give the same answer on a box
# with no outbound HTTP as on a workstation, and the list changes about once a
# year. Refresh it by hand; VIDEOFY_CLOUDFLARE_IPS_FILE overrides it with a
# file of one CIDR per line for a check against the live list.
VIDEOFY_CLOUDFLARE_IPV4="173.245.48.0/20
103.21.244.0/22
103.22.200.0/22
103.31.4.0/22
141.101.64.0/18
108.162.192.0/18
190.93.240.0/20
188.114.96.0/20
197.234.240.0/22
198.41.128.0/17
162.158.0.0/15
104.16.0.0/13
104.24.0.0/14
172.64.0.0/13
131.0.72.0/22"

# The one origin address in the ruling. A permitted hostname must land here.
VIDEOFY_TURN_ORIGIN_IP="169.58.215.77"

# Hostnames that are proxied by design and can therefore NEVER carry TURN,
# whatever DNS says at the moment the check runs. Named so the guard refuses
# them even before the apex record exists.
VIDEOFY_TURN_FORBIDDEN_HOSTS="consummate7.com www.consummate7.com staging.consummate7.com"

_videofy_ip_to_int() {
  local a b c d
  IFS=. read -r a b c d <<< "$1"
  printf '%s' "$(( (a << 24) + (b << 16) + (c << 8) + d ))"
}

_videofy_is_ipv4() {
  case "$1" in
    *[!0-9.]*) return 1 ;;
  esac
  local a b c d rest o
  IFS=. read -r a b c d rest <<< "$1"
  [ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] && [ -n "$d" ] && [ -z "${rest:-}" ] || return 1
  for o in "$a" "$b" "$c" "$d"; do
    [ "$o" -ge 0 ] 2>/dev/null && [ "$o" -le 255 ] 2>/dev/null || return 1
  done
  return 0
}

_videofy_in_cloudflare() {
  local ip="$1" cidr net bits ipint netint mask ranges
  _videofy_is_ipv4 "$ip" || return 1
  ipint="$(_videofy_ip_to_int "$ip")"
  if [ -n "${VIDEOFY_CLOUDFLARE_IPS_FILE:-}" ] && [ -r "${VIDEOFY_CLOUDFLARE_IPS_FILE}" ]; then
    ranges="$(cat "$VIDEOFY_CLOUDFLARE_IPS_FILE")"
  else
    ranges="$VIDEOFY_CLOUDFLARE_IPV4"
  fi
  while IFS= read -r cidr; do
    [ -n "$cidr" ] || continue
    net="${cidr%%/*}"
    bits="${cidr##*/}"
    _videofy_is_ipv4 "$net" || continue
    netint="$(_videofy_ip_to_int "$net")"
    if [ "$bits" -eq 0 ]; then mask=0; else mask=$(( (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF )); fi
    if [ $(( ipint & mask )) -eq $(( netint & mask )) ]; then return 0; fi
  done <<< "$ranges"
  return 1
}

# Resolve A records with whatever this machine has. The box has getent; the
# Windows workstation that runs smoke.sh has neither getent nor dig, so python
# and nslookup are real fallbacks rather than decoration. An unresolvable
# hostname is a REFUSAL, not a pass: a guard that cannot see the address has
# not cleared it.
_videofy_resolve_a() {
  local host="$1" out="" py
  if command -v getent >/dev/null 2>&1; then
    out="$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u)"
  fi
  if [ -z "$out" ] && command -v dig >/dev/null 2>&1; then
    out="$(dig +short +time=5 A "$host" 2>/dev/null | grep -E '^[0-9.]+$' | sort -u)"
  fi
  if [ -z "$out" ]; then
    for py in python3 python; do
      command -v "$py" >/dev/null 2>&1 || continue
      out="$("$py" -c 'import socket, sys
try:
    print("\n".join(sorted({i[4][0] for i in socket.getaddrinfo(sys.argv[1], None, socket.AF_INET)})))
except Exception:
    pass' "$host" 2>/dev/null)"
      [ -n "$out" ] && break
    done
  fi
  if [ -z "$out" ] && command -v nslookup >/dev/null 2>&1; then
    # Windows nslookup prints the query server's own address first; only the
    # lines AFTER the "Name:" line belong to the answer.
    out="$(nslookup "$host" 2>/dev/null | tr -d '\r' | awk '
      /^Name:/ { seen = 1; next }
      seen && /^(Address|Addresses):/ { sub(/^[^:]*:[ \t]*/, ""); print }
      seen && /^[ \t]+[0-9a-fA-F:.]+$/ { gsub(/[ \t]/, ""); print }
    ' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u)"
  fi
  printf '%s' "$out"
}

# 0 approved, 1 refused, 2 not configured.
videofy_turn_guard() {
  local host="${1:-}" label="${2:-TURN_HOST}" addrs="" ip bad=0 forbidden joined

  if [ -z "$host" ]; then
    echo "turn-guard: $label is not set -- no relay configured (calls across NAT will fail; not a proxy violation)"
    return 2
  fi

  # Names first, so the refusal holds even before the record exists.
  for forbidden in $VIDEOFY_TURN_FORBIDDEN_HOSTS; do
    if [ "$host" = "$forbidden" ]; then
      echo "turn-guard: REFUSED -- $label=$host is a Cloudflare-PROXIED hostname."
      echo "turn-guard: the ordinary Cloudflare proxy carries HTTP only; TURN over it never connects."
      echo "turn-guard: use $VIDEOFY_TURN_ORIGIN_IP (direct origin) or a DNS-ONLY turn.consummate7.com A record."
      return 1
    fi
  done

  if _videofy_is_ipv4 "$host"; then
    addrs="$host"
  else
    addrs="$(_videofy_resolve_a "$host")"
    if [ -z "$addrs" ]; then
      echo "turn-guard: REFUSED -- $label=$host does not resolve to an IPv4 address from here."
      echo "turn-guard: an address this check cannot see is an address it cannot clear."
      return 1
    fi
  fi

  for ip in $addrs; do
    if _videofy_in_cloudflare "$ip"; then
      echo "turn-guard: REFUSED -- $label=$host resolves to $ip, inside a Cloudflare range."
      echo "turn-guard: that record is PROXIED (orange cloud). Grey-cloud it (DNS only), or set"
      echo "turn-guard: $label=$VIDEOFY_TURN_ORIGIN_IP and re-run. Cloudflare proxies HTTP, not UDP 3478."
      bad=1
    fi
  done
  [ "$bad" -eq 0 ] || return 1

  for ip in $addrs; do
    if [ "$ip" = "$VIDEOFY_TURN_ORIGIN_IP" ]; then
      if [ "$host" = "$VIDEOFY_TURN_ORIGIN_IP" ]; then
        echo "turn-guard: ok -- $label=$host (the proven direct-origin arrangement)"
      else
        echo "turn-guard: ok -- $label=$host resolves DNS-only to $ip (the optional hostname arrangement)"
      fi
      return 0
    fi
  done

  # Not Cloudflare, but not the origin either: a second relay is legitimate and
  # a typo is not, and this guard cannot tell them apart. Say so, and pass.
  joined="$(printf '%s' "$addrs" | tr '\n' ' ' | sed 's/ *$//')"
  echo "turn-guard: warn -- $label=$host resolves to $joined (not Cloudflare, not the known origin $VIDEOFY_TURN_ORIGIN_IP)"
  return 0
}
