#!/usr/bin/env bash
# @author masterzee001
#
# RESTART-PERSISTENCE PROOF -- runbook step 21.
#
# Founder addition to the locked production ruling, 30 Aug 2026: after the
# first channel identity edit, restart the production account service and
# prove the channel display name and @handle SURVIVE. The point is not that
# the edit worked; the point is that it was written to Postgres by migration
# 020 (`020_channel_profiles`) rather than held in a process's memory. Those
# two look identical from a browser right up to the first deploy, and then one
# of them silently loses every channel on the platform.
#
# The proof, in order:
#
#   1. GET <origin>/auth/streams/<handle> and record channelId, handle,
#      displayName, description, category, visibility.
#   2. Record the account unit's MainPID.
#   3. `systemctl restart videofy-prod-account`.
#   4. Wait for /auth/health to answer 200 again.
#   5. Assert the MainPID CHANGED -- a restart that quietly did nothing would
#      otherwise "pass" this check while proving nothing at all.
#   6. GET the same route and compare every recorded field.
#   7. Any difference, and any 404, is a LOUD FAILURE.
#
#   bash deploy/production/check-restart-persistence.sh <handle> [staging|production]
#
#   RESTART_VIA=local|ssh   default: local if the unit is visible here, else ssh
#
# Reads a PUBLIC route and a unit's PID. No env file is opened, no credential
# is read, nothing is printed that is not already public on the channel page.
set -uo pipefail

HANDLE="${1:?usage: check-restart-persistence.sh <handle> [staging|production]}"
ENV_NAME="${2:-production}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/env.sh
. "$HERE/../lib/env.sh"
videofy_env "$ENV_NAME"
ORIGIN="${ORIGIN:-$VIDEOFY_PUBLIC_ORIGIN}"
UNIT="${VIDEOFY_UNIT_PREFIX}-account"

# The fields that make a channel that channel. channelId is included because a
# handle that survives on a DIFFERENT channel id is not persistence, it is a
# re-claim by the next signed-in owner.
FIELDS="channelId handle displayName description category visibility"

fail() { echo "PERSISTENCE FAILED: $*"; exit 1; }

# Field extraction through node: the payload is JSON and a regex over JSON is
# a defect waiting for a description that contains a quote.
read_profile() {
  local body status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$ORIGIN/auth/streams/$HANDLE" || echo 000)"
  [ "$status" = "200" ] || { echo "HTTP $status"; return 1; }
  body="$(curl -s --max-time 20 "$ORIGIN/auth/streams/$HANDLE")"
  printf '%s' "$body" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      const p = JSON.parse(raw);
      for (const f of process.argv[1].split(" ")) {
        console.log(f + "=" + (p[f] === null || p[f] === undefined ? "<null>" : String(p[f])));
      }
    });
  ' "$FIELDS"
}

unit_pid() {
  if [ "$VIA" = "local" ]; then
    systemctl show -p MainPID --value "$UNIT" 2>/dev/null
  else
    ssh "$VIDEOFY_SSH_HOST" "systemctl show -p MainPID --value $UNIT" 2>/dev/null
  fi
}

restart_unit() {
  if [ "$VIA" = "local" ]; then
    sudo -n systemctl restart "$UNIT"
  else
    ssh "$VIDEOFY_SSH_HOST" "sudo -n systemctl restart $UNIT"
  fi
}

VIA="${RESTART_VIA:-}"
if [ -z "$VIA" ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl cat "$UNIT" >/dev/null 2>&1; then VIA=local; else VIA=ssh; fi
fi
echo "restart-persistence: $ORIGIN/auth/streams/$HANDLE, unit $UNIT via $VIA"

BEFORE="$(read_profile)" || fail "the channel is not readable BEFORE the restart ($BEFORE). Create and edit it first."
echo "-- before restart --"
printf '%s\n' "$BEFORE" | sed 's/^/  /'

PID_BEFORE="$(unit_pid)"
[ -n "$PID_BEFORE" ] || fail "cannot read $UNIT MainPID (via $VIA); nothing would prove the restart happened"

restart_unit || fail "systemctl restart $UNIT did not succeed"

# The account service applies migrations and proves the database reachable
# before it listens, so /auth/health answering 200 is the whole boot sequence
# having completed, not merely a port opening.
UP=0
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$ORIGIN/auth/health" || echo 000)" = "200" ]; then UP=1; break; fi
  sleep 2
done
[ "$UP" -eq 1 ] || fail "$UNIT did not answer /auth/health within 60s of the restart"

PID_AFTER="$(unit_pid)"
[ -n "$PID_AFTER" ] && [ "$PID_AFTER" != "$PID_BEFORE" ] || \
  fail "$UNIT MainPID did not change ($PID_BEFORE -> ${PID_AFTER:-none}); the process never restarted, so this proves nothing"
echo "-- restarted: MainPID $PID_BEFORE -> $PID_AFTER --"

AFTER="$(read_profile)" || fail "the channel is GONE after the restart ($AFTER). It was in memory, not in the database: migration 020 did not persist it."
echo "-- after restart --"
printf '%s\n' "$AFTER" | sed 's/^/  /'

DIFF=0
for f in $FIELDS; do
  b="$(printf '%s\n' "$BEFORE" | sed -n "s/^$f=//p")"
  a="$(printf '%s\n' "$AFTER" | sed -n "s/^$f=//p")"
  if [ "$b" != "$a" ]; then
    echo "FAIL $f changed across the restart: '$b' -> '$a'"
    DIFF=1
  else
    echo "ok   $f survived: '$a'"
  fi
done

[ "$DIFF" -eq 0 ] || fail "channel identity did not survive $UNIT restarting"
echo "PERSISTENCE PROVED: $HANDLE is durable across a $UNIT restart (migration 020, not process memory)"
