#!/usr/bin/env bash
# @author masterzee001
#
# What systemd is actually enforcing, asked of systemd, before anything moves.
#
# TWO LESSONS ARE ENCODED HERE, both of which cost a production incident.
#
# The first: a unit file on disk is not a unit systemd is running. The restart
# limiter was correct in the repository for days while the real production unit
# ran the defaults, and media-ingest reached 133,247 restarts underneath it.
# Reading the file would have confirmed the repository's own opinion of itself.
#
# The second: a drop-in outlives the unit it overrides. `deploy.sh` reconciled
# base units and never looked at `<unit>.service.d/`, so an emergency drop-in
# pinning WorkingDirectory to a release tree would have survived a deploy,
# left one service on stale code, and let the deploy report success.
#
# So this file only ever ASKS. It installs nothing, reloads nothing, removes no
# drop-in and restarts no service. An ordinary application release must not be
# able to change systemd semantics as a side effect -- that is what made the
# old model able to leave partially staged configuration behind when it
# refused. A unit change is a separate, separately qualified act.

# shellcheck source=./release-paths.sh
. "$(dirname "${BASH_SOURCE[0]}")/release-paths.sh"

# `systemctl show` is the authority. Overridable for tests, which supply a stub
# that answers from a fixture rather than from the host's real daemon.
SYSTEMCTL="${SYSTEMCTL:-systemctl}"

unit_property() {
  local unit="$1" property="$2"
  # `show` answers 0 even for a unit that does not exist, returning an empty
  # value -- so an empty answer means "nothing configured", never "the command
  # failed", and this cannot abort a caller running under `set -e`.
  "$SYSTEMCTL" show "$unit" -p "$property" --value 2>/dev/null
}

# Every drop-in systemd has loaded for a unit, which is the part `deploy.sh`
# could not see.
unit_dropins() {
  local unit="$1"
  "$SYSTEMCTL" show "$unit" -p DropInPaths --value 2>/dev/null
}

# Does every unit resolve its WorkingDirectory through the stable pointer?
#
# THE CONTRACT FOR A CONVERGED HOST. Units name `<current>/services/<name>`,
# the pointer is what a deployment moves, and no per-release drop-in exists
# because no release needs one. Anything else -- a release tree named directly,
# an emergency drop-in still in place, a path outside the pointer -- is refused
# BEFORE the cutover, while refusing still costs nothing.
#
# Refusal is loud and names the file to look at. The one thing it must never do
# is fix the problem itself: an unknown drop-in is somebody's incident
# response, and deleting it to make a deploy proceed is how the evidence of an
# outage gets destroyed by the tool that should have stopped.
assert_units_resolve_through_pointer() {
  local current="$1"; shift
  local refused=0 unit wd dropins
  assert_safe_path 'CURRENT_POINTER' "$current" || return 1

  for unit in "$@"; do
    wd="$(unit_property "$unit" WorkingDirectory)"
    # Older systemd renders this as `path=/x ; ignore_enoent=no`; newer answers
    # the bare path. Accept both rather than depending on the daemon's version.
    wd="$(printf '%s' "$wd" | sed 's/^.*path=//; s/ ;.*$//')"

    if [ -z "$wd" ]; then
      echo "REFUSED: $unit reports no WorkingDirectory." >&2
      echo "  A converged host names it explicitly; an empty answer means this" >&2
      echo "  unit is not the one this deployment believes it is deploying." >&2
      refused=1
      continue
    fi

    if ! path_is_within "$current" "$wd"; then
      echo "REFUSED: $unit resolves WorkingDirectory to $wd" >&2
      echo "  which is outside the runtime pointer $current." >&2
      echo "  Publishing would move the pointer and leave $unit on other code," >&2
      echo "  and the deploy would report success. Inspect:" >&2
      echo "    systemctl cat $unit" >&2
      echo "    /etc/systemd/system/$unit.service.d/" >&2
      refused=1
      continue
    fi

    dropins="$(unit_dropins "$unit")"
    if [ -n "$dropins" ]; then
      # A drop-in that does not touch WorkingDirectory is ordinary and allowed
      # -- environment, limits, ordering all live there legitimately. What is
      # refused is one that redirects where the code is read from, because that
      # is the override the pointer cannot win against.
      local file
      for file in $dropins; do
        if grep -qE '^[[:space:]]*WorkingDirectory=' "$file" 2>/dev/null; then
          echo "REFUSED: $unit has a drop-in overriding WorkingDirectory: $file" >&2
          echo "  It would survive this deployment and outlive the release it" >&2
          echo "  pins. Remove it deliberately, as its own reviewed change --" >&2
          echo "  this deployment will not remove it for you." >&2
          refused=1
        fi
      done
    fi
  done
  return "$refused"
}

# The restart limiter, read back from the daemon rather than from a file.
#
# Without it a crash loop runs forever: production media-ingest reached 133,247
# restarts under a unit that carried no StartLimit block at all. The values are
# one calculation -- 3s base, 5 steps, 60s ceiling is a geometric ratio of
# (60/3)^(1/5) = 1.82 -- so a limiter is "reachable" only if the interval is
# long enough for the burst to actually be spent inside it.
assert_restart_limiter() {
  local refused=0 unit interval burst
  for unit in "$@"; do
    interval="$(unit_property "$unit" StartLimitIntervalUSec)"
    burst="$(unit_property "$unit" StartLimitBurst)"
    if [ -z "$burst" ] || [ "$burst" = "0" ]; then
      echo "REFUSED: $unit has no start limit burst; a crash loop would never stop" >&2
      refused=1
      continue
    fi
    case "$interval" in
      ''|0|infinity)
        echo "REFUSED: $unit has no start limit interval ($interval)" >&2
        refused=1 ;;
    esac
  done
  return "$refused"
}
