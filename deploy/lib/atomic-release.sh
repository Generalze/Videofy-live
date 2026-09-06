#!/usr/bin/env bash
# @author masterzee001
#
# The order the steps go in, which is the entire correctness argument.
#
# Every expensive, fallible or slow thing happens while the running system
# cannot see it. Then the gates run, still invisibly. Then two renames make the
# whole thing real at once. There is no step between "unqualified" and
# "serving" for an external restart to land in, because the pointer a service
# resolves is not touched until every gate has already passed.
#
#   PREPARE      candidate dir nothing points at   restart -> OLD release
#   BUILD        inside the candidate              restart -> OLD release
#   WEB BUILD    inside the candidate              restart -> OLD release
#   GATE  config preflight, real production rules  restart -> OLD release
#   GATE  effective systemd units and drop-ins     restart -> OLD release
#   SEAL         RELEASE.json written last         restart -> OLD release
#   -------------------------------------------------- the authorised boundary
#   PUBLISH      ONE rename of `current`           restart -> NEW release
#   RESTART      planned, deliberate               restart -> NEW release
#   VERIFY       health, running-release, smoke    restart -> NEW release
#
# A failure anywhere above the line leaves both pointers where they were, so
# the deployment is not an event the running system can observe. A failure
# BELOW the line is a rollback, which is another rename to a release that is
# still on disk and still qualified.
#
# WHAT THIS DELIBERATELY DOES NOT DO: install systemd units, reload the daemon,
# remove a drop-in, touch Caddy, run a migration, or disable a timer. Each of
# those was available to the old model as a side effect of an ordinary release,
# and each is how a refused deploy left something behind.

# shellcheck source=./release-paths.sh
. "$(dirname "${BASH_SOURCE[0]}")/release-paths.sh"
# shellcheck source=./release-engine.sh
. "$(dirname "${BASH_SOURCE[0]}")/release-engine.sh"
# shellcheck source=./effective-units.sh
. "$(dirname "${BASH_SOURCE[0]}")/effective-units.sh"

# Run every pre-cutover gate against a candidate that nothing points at yet.
#
# THE 2026-09-05 LESSON IS THE REASON THE CONFIG GATE EXISTS. media-ingest
# refused to boot on `TRANSLATION_ROUTES_DOCUMENT is required in production`,
# a guard inside an `isProduction` branch that staging -- running
# C7_ENVIRONMENT=staging -- can never evaluate. A fully certified staging wave
# proved nothing about it. The only thing that could find it was starting the
# candidate against the real production environment file, and the only safe
# place to do that is here, before anything points at the candidate.
#
# It runs the candidate in a validation mode that exercises the startup
# configuration gates and then exits, so it never binds the service port, never
# joins the gateway, never advertises itself to routing and never becomes a
# second consumer of live work.
atomic_gate_candidate() {
  local candidate="$1" env_file="$2" preflight_cmd="$3"; shift 3
  local units="$*"
  local failed=0

  if [ -n "$preflight_cmd" ]; then
    echo "gate: production configuration preflight"
    if ! "$preflight_cmd" "$candidate" "$env_file"; then
      echo "REFUSED: the candidate does not satisfy this environment's own startup rules." >&2
      echo "  Staging cannot prove these: they live behind an isProduction branch." >&2
      failed=1
    fi
  fi

  if [ -n "$units" ]; then
    echo "gate: effective systemd configuration"
    # shellcheck disable=SC2086
    assert_units_resolve_through_pointer "$ATOMIC_CURRENT" $units || failed=1
    # shellcheck disable=SC2086
    assert_restart_limiter $units || failed=1
  fi

  return "$failed"
}

# The whole deployment, in the one order that keeps the invariant.
#
# ATOMIC_ROOT / ATOMIC_RELEASES / ATOMIC_CURRENT / ATOMIC_WWW must be set and
# are validated before anything is written through them, because a guard built
# from an empty variable is a guard that passes.
atomic_deploy() {
  local sha="$1" ref="$2" prepare_body="$3" env_file="$4" preflight_cmd="$5"
  local restart_cmd="$6" verify_cmd="$7"; shift 7
  local units="$*"

  assert_release_paths "$ATOMIC_ROOT" "$ATOMIC_RELEASES" "$ATOMIC_CURRENT" "$ATOMIC_WWW" || return 1
  assert_full_sha 'requested sha' "$sha" || return 1

  local previous
  previous="$(pointer_sha "$ATOMIC_CURRENT" "$ATOMIC_RELEASES")"
  echo "previous release: $previous"

  # ---------------------------------------------------------------- prepare
  # Everything below happens inside a directory nothing resolves. An external
  # restart at any point here boots `$previous`, unchanged.
  # CAPTURED IN DISTINCTLY NAMED GLOBALS, not in the locals above.
  #
  # bash scopes dynamically, and `release_prepare` declares its own
  # `local prepare_body` -- which it sets to this very function. Read from
  # inside the callback, `$prepare_body` therefore resolved to
  # `__atomic_prepare_body` itself and recursed until the shell died. A
  # closure that reads a name its caller also uses is not a closure.
  __ATOMIC_BUILD_FN="$prepare_body"
  __ATOMIC_ENV_FILE="$env_file"
  __ATOMIC_PREFLIGHT_FN="$preflight_cmd"
  __ATOMIC_UNITS="$units"
  __atomic_prepare_body() {
    "$__ATOMIC_BUILD_FN" "$1" || return 1
    # The gates run INSIDE preparation, so a candidate that fails one is never
    # sealed and therefore can never be published, rolled back to, or mistaken
    # for a release by a later deploy.
    # shellcheck disable=SC2086
    atomic_gate_candidate "$1" "$__ATOMIC_ENV_FILE" "$__ATOMIC_PREFLIGHT_FN" $__ATOMIC_UNITS || return 1
    return 0
  }
  if ! release_prepare "$ATOMIC_RELEASES" "$sha" "$ref" __atomic_prepare_body; then
    echo "DEPLOY FAILED before the cutover boundary." >&2
    echo "  current still -> $(pointer_target "$ATOMIC_CURRENT")" >&2
    echo "  A restart right now boots $previous, which passed its gates." >&2
    return 1
  fi

  # ------------------------------------------------- the authorised boundary
  echo "publishing $sha"
  if ! release_publish "$ATOMIC_RELEASES" "$sha" "$ATOMIC_CURRENT"; then
    echo "DEPLOY FAILED during publication." >&2
    release_state "$ATOMIC_RELEASES" "$ATOMIC_CURRENT" "$ATOMIC_WWW" >&2
    return 1
  fi
  echo "published: current -> $(pointer_target "$ATOMIC_CURRENT")"

  # ---------------------------------------------------------------- activate
  # From here a failure is a ROLLBACK rather than a refusal, because the new
  # release is already what a restart would boot. The previous release is still
  # sealed on disk, so going back is a rename and not a rebuild.
  if [ -n "$restart_cmd" ] && ! "$restart_cmd"; then
    echo "DEPLOY FAILED: services did not restart onto $sha" >&2
    __atomic_rollback "$previous"
    return 1
  fi
  if [ -n "$verify_cmd" ] && ! "$verify_cmd" "$sha"; then
    echo "DEPLOY FAILED: $sha did not verify after restart" >&2
    __atomic_rollback "$previous"
    return 1
  fi

  atomic_record_state "$sha" "$previous"
  echo "DEPLOYED $sha"
  return 0
}

__atomic_rollback() {
  local previous="$1"
  case "$previous" in
    none|unmanaged:*)
      echo "CANNOT ROLL BACK: previous release is '$previous'." >&2
      echo "  current -> $(pointer_target "$ATOMIC_CURRENT")" >&2
      echo "  This host has no earlier sealed release to return to." >&2
      return 1 ;;
  esac
  echo "rolling back to $previous"
  if release_rollback "$ATOMIC_RELEASES" "$previous" "$ATOMIC_CURRENT"; then
    echo "rolled back: current -> $(pointer_target "$ATOMIC_CURRENT")"
    echo "  RESTART THE SERVICES: they are still running the failed release." >&2
    return 0
  fi
  echo "ROLLBACK FAILED; current -> $(pointer_target "$ATOMIC_CURRENT")" >&2
  return 1
}

# What is live, what it replaced, and where to go back to.
#
# Written where an operator looks first, because the question after an incident
# is never "what does the repository say" -- it is "what is this box running,
# and what was it running an hour ago".
atomic_record_state() {
  local sha="$1" previous="$2"
  local file="$ATOMIC_ROOT/DEPLOY-STATE.md"
  local tmp="$file.tmp.$$"
  {
    printf '# Deployment state\n\n'
    printf 'Written by the deploy. The pointers below are the authority; a git\n'
    printf 'checkout under this root is not.\n\n'
    printf '| | |\n|---|---|\n'
    printf '| active | `%s` |\n' "$sha"
    printf '| previous | `%s` |\n' "$previous"
    printf '| release path | `%s/%s` |\n' "$ATOMIC_RELEASES" "$sha"
    printf '| cutover (UTC) | %s |\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '\n## Rolling back\n\n'
    printf 'The previous release is still sealed on disk. No rebuild is needed:\n\n'
    printf '```\nbash deploy/atomic-deploy.sh %s rollback %s\n```\n\n' "${ATOMIC_ENV:-production}" "$previous"
    printf '## Pointers\n\n```\n'
    release_state "$ATOMIC_RELEASES" "$ATOMIC_CURRENT" "$ATOMIC_WWW"
    printf '```\n'
  } > "$tmp"
  mv -f "$tmp" "$file"
}
