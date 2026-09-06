#!/usr/bin/env bash
# @author masterzee001
#
# Turning a published release into running processes, and proving it happened.
#
# WHY THIS IS ITS OWN FILE. Deployment and rollback must be held to the SAME
# standard -- restart, health, and proof that the processes are executing the
# release the pointer names. When those steps live inside the deploy path,
# rollback quietly gets a weaker version, and "rolled back" comes to mean "the
# pointer moved" while every process still runs the release being abandoned.
# One implementation, called by both, makes that asymmetry impossible.
#
# THE DISTINCTION THIS FILE EXISTS TO ENFORCE:
#
#   what a restart WOULD boot   = the pointer          (cheap, always true)
#   what is CURRENTLY serving   = the processes        (the thing that matters)
#
# They are not the same, and a deployment that checks only the first is
# checking its own paperwork.

# `systemctl` is overridable so tests can drive a stub, and so this file can be
# reasoned about without a running daemon.
SYSTEMCTL="${SYSTEMCTL:-systemctl}"

activation_restart() {
  local unit state
  echo "restarting: ${ATOMIC_UNITS:-}"
  for unit in ${ATOMIC_UNITS:-}; do
    if ! sudo -n "$SYSTEMCTL" restart "$unit"; then
      echo "  $unit failed to restart" >&2
      return 1
    fi
  done
  # ACTIVE IS CHECKED SEPARATELY FROM RESTARTING, because `systemctl restart`
  # returns as soon as the job is accepted; a unit that starts and immediately
  # dies satisfies the command and not the deployment.
  for unit in ${ATOMIC_UNITS:-}; do
    state="$("$SYSTEMCTL" is-active "$unit" 2>/dev/null || true)"
    if [ "$state" != "active" ]; then
      echo "  $unit is '$state', not active" >&2
      return 1
    fi
  done
  return 0
}

activation_health() {
  local failed=0 name port code
  for probe in "account ${ACCOUNT_PORT:-}" "gateway ${GATEWAY_PORT:-}" "media-ingest ${INGEST_PORT:-}"; do
    # shellcheck disable=SC2086
    set -- $probe
    name="$1"; port="$2"
    [ -n "$port" ] || continue
    code=000
    # RETRY, DON'T RACE. systemd reports a unit active the moment the process
    # is forked; node still has to import, connect and bind. Probing once
    # reported 000 for services that answered 200 eight seconds later, and a
    # gate that fails spuriously erodes trust exactly as much as one that
    # passes wrongly -- because the next real failure gets waved through.
    for _ in $(seq 1 15); do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/health" || true)"
      [ "$code" = "200" ] && break
      sleep 2
    done
    echo "  $name :$port/health $code"
    [ "$code" = "200" ] || failed=1
  done
  return "$failed"
}

# Are the PROCESSES running the release we published?
#
# THE HALF THE POINTER CANNOT ANSWER. A unit systemd left alone because its
# file did not change, or one whose restart silently failed, keeps executing
# the previous release from open file handles while the pointer says otherwise
# -- and every paper check passes. So each unit's main process must have
# started AFTER the publication, and the pointer must name the expected SHA.
activation_running_release() {
  local expected="$1" unit ts started stale=0
  local published
  published="$(pointer_sha "$ATOMIC_CURRENT" "$ATOMIC_RELEASES")"
  if [ "$published" != "$expected" ]; then
    echo "  pointer names $published, expected $expected" >&2
    return 1
  fi
  # The instant the pointer moved. Anything started before it is still running
  # the release we moved away from.
  local boundary
  boundary="$(stat -c %Y "$ATOMIC_CURRENT" 2>/dev/null || echo 0)"
  for unit in ${ATOMIC_UNITS:-}; do
    ts="$("$SYSTEMCTL" show -p ExecMainStartTimestamp --value "$unit" 2>/dev/null || true)"
    if [ -z "$ts" ]; then
      echo "  cannot read ExecMainStartTimestamp for $unit" >&2
      stale=1
      continue
    fi
    started="$(date -d "$ts" +%s 2>/dev/null || echo 0)"
    if [ "$started" -lt "$boundary" ]; then
      echo "  $unit has been running since $ts, BEFORE this release was published." >&2
      echo "    It is still executing the previous code." >&2
      stale=1
    fi
  done
  [ "$stale" -eq 0 ] || return 1
  echo "  every unit is running $expected"
  return 0
}

# The production-only startup rules, evaluated by a process that starts nothing.
activation_preflight() {
  local candidate="$1" env_file="$2"
  node "$(dirname "${BASH_SOURCE[0]}")/preflight-config.mjs" "$candidate" "$env_file"
}
