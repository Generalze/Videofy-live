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
  #
  # RUN AS THE SERVICE USER, not as the deploy user, and not as root.
  #
  # The environment file is 0640 root:<service group> and holds provider keys.
  # The deploy user cannot read it, which is correct -- widening that to make a
  # preflight work would hand the deployment account every production secret
  # permanently, to answer a question that takes a second. Running as root
  # would answer the wrong question entirely: root can read anything, so a pass
  # would prove nothing about the identity that actually boots the service.
  #
  # The service user is the one that reads this file at startup, so evaluating
  # the configuration AS that user is both the safe choice and the faithful
  # one: it proves the process that will really run can reach what it needs.
  #
  # NO SILENT DEFAULT. An earlier version fell back to a hardcoded "videofy",
  # which would have kept working while silently testing the wrong identity on
  # any host that named its service user differently.
  local runner="${ATOMIC_SERVICE_USER:-}"
  if [ -z "$runner" ]; then
    echo "PREFLIGHT FAILED: no service identity was configured." >&2
    echo "  ATOMIC_SERVICE_USER must name the user this environment's services" >&2
    echo "  run as; guessing it would test the wrong identity and still pass." >&2
    return 1
  fi

  # THE CONFIGURED IDENTITY MUST BE THE ONE SYSTEMD ACTUALLY USES. Otherwise a
  # preflight can pass as a user no service ever runs as.
  local unit effective
  for unit in ${ATOMIC_UNITS:-}; do
    effective="$("$SYSTEMCTL" show "$unit" -p User --value 2>/dev/null)"
    [ -n "$effective" ] || continue
    if [ "$effective" != "$runner" ]; then
      echo "PREFLIGHT FAILED: $unit runs as '$effective', not '$runner'." >&2
      echo "  The configured service identity disagrees with systemd; a check" >&2
      echo "  run as the wrong user proves nothing about the real startup." >&2
      return 1
    fi
  done

  #
  # ONE PROGRAM, NOT FOUR COMMANDS.
  #
  # This used to run `sudo -u $runner test` three times and then
  # `sudo -u $runner node <script-from-/tmp>`. Making that work needs
  #
  #     claude ALL=(videofy) NOPASSWD: /usr/bin/node, /usr/bin/test
  #
  # in production's sudoers, and `node` with a caller-chosen script is
  # arbitrary code execution as the service user -- with the script living
  # under /tmp, owned by the deploy account. That is not a preflight
  # permission, it is a second identity.
  #
  # Production instead grants exactly one program, whose environment file, node
  # binary and implementation are compiled in, and which decides for itself
  # whether the path it was handed is a real candidate. The three capability
  # questions are asked inside it, so a refusal still names the missing one.
  if [ "${ATOMIC_ENV:-}" = 'production' ]; then
    local helper="${ATOMIC_PREFLIGHT_HELPER:-/usr/local/sbin/videofy-production-preflight}"
    #
    # NO FALLBACK. Dropping back to the generic commands here would mean the
    # policy could be narrowed and the code would quietly keep asking for the
    # grant that was just removed -- failing at the least useful moment, with
    # a sudo error instead of an explanation.
    if [ ! -x "$helper" ]; then
      echo "PREFLIGHT FAILED: $helper is not installed." >&2
      echo "  Production runs its preflight through one fixed program rather" >&2
      echo "  than through generic node and test authority as $runner." >&2
      echo "    sudo bash deploy/production/install-sudo-hardening.sh" >&2
      return 1
    fi
    sudo -n -u "$runner" "$helper" "$candidate"
    return $?
  fi

  # Non-production keeps the direct form: its sudo policy is separate, its
  # environment file is not production's, and narrowing it is its own package.
  local script
  script="$(dirname "${BASH_SOURCE[0]}")/preflight-config.mjs"

  # Each capability the real startup needs, proven as that identity and named
  # separately, so a refusal says which one is missing rather than "it failed".
  if ! sudo -n -u "$runner" test -x "$candidate" 2>/dev/null; then
    echo "PREFLIGHT FAILED: $runner cannot traverse the candidate release." >&2
    return 1
  fi
  if ! sudo -n -u "$runner" test -r "$candidate/services/media-ingest/dist/services/media-ingest/src/config.js" 2>/dev/null; then
    echo "PREFLIGHT FAILED: $runner cannot read the candidate's config module." >&2
    return 1
  fi
  if ! sudo -n -u "$runner" test -r "$env_file" 2>/dev/null; then
    echo "PREFLIGHT FAILED: $runner cannot read $env_file" >&2
    echo "  The service user must be able to read its own environment file;" >&2
    echo "  do NOT widen the file's permissions to make this pass." >&2
    return 1
  fi
  sudo -n -u "$runner" node "$script" "$candidate" "$env_file"
}
