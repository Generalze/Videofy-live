#!/usr/bin/env bash
# @author masterzee001
#
# The order the steps go in, which is the entire correctness argument.
#
# Every expensive, fallible or slow thing happens while the running system
# cannot see it. Then the gates run, still invisibly. Then ONE rename makes the
# whole thing real -- the API and the site together, because `www` resolves
# through `current` rather than being a second release pointer.
#
#   PREPARE      candidate dir nothing points at   restart -> OLD release
#   BUILD        inside the candidate              restart -> OLD release
#   WEB BUILD    inside the candidate              restart -> OLD release
#   GATE  config preflight, real production rules  restart -> OLD release
#   GATE  effective systemd units and drop-ins     restart -> OLD release
#   SEAL         manifest, then marker, last       restart -> OLD release
#   -------------------------------------------------- the authorised boundary
#   PUBLISH      one rename of `current`           restart -> NEW release
#   RESTART      planned, deliberate               restart -> NEW release
#   HEALTH       loopback                          restart -> NEW release
#   RUNNING      processes prove their release     restart -> NEW release
#   SMOKE        through the public edge           restart -> NEW release
#
# A failure anywhere above the line leaves the pointer where it was, so the
# deployment is not an event the running system can observe. A failure BELOW
# the line is a ROLLBACK -- and a rollback here is a complete version
# transition, not merely a pointer move. See `atomic_rollback_transition`.
#
# WHAT THIS DELIBERATELY DOES NOT DO: install systemd units, reload the daemon,
# remove a drop-in, touch Caddy, run a migration, or disable a timer. Each of
# those was available to the old model as a side effect of an ordinary release,
# and each is how a refused deploy left something behind.
#
# CALLBACKS ARE READ FROM NAMED GLOBALS rather than passed positionally. Nine
# positional parameters is how a caller silently swaps two of them and bash
# says nothing; naming them also stops `release_prepare`'s own locals from
# shadowing them, which caused an infinite recursion the first time this file
# used a closure.
#
#   ATOMIC_FN_BUILD      build the release into $1 (the candidate directory)
#   ATOMIC_FN_PREFLIGHT  evaluate this environment's startup rules on $1
#   ATOMIC_FN_RESTART    restart every intended service, in order
#   ATOMIC_FN_HEALTH     loopback health for every service
#   ATOMIC_FN_RUNNING    prove the processes are executing $1 (a sha)
#   ATOMIC_FN_SMOKE      public smoke through the real edge
#   ATOMIC_UNITS         the units this environment owns
#   ATOMIC_ENV_FILE      the real environment file for the preflight

# shellcheck source=./release-paths.sh
. "$(dirname "${BASH_SOURCE[0]}")/release-paths.sh"
# shellcheck source=./release-engine.sh
. "$(dirname "${BASH_SOURCE[0]}")/release-engine.sh"
# shellcheck source=./effective-units.sh
. "$(dirname "${BASH_SOURCE[0]}")/effective-units.sh"
# shellcheck source=./deploy-lock.sh
. "$(dirname "${BASH_SOURCE[0]}")/deploy-lock.sh"

# Run every pre-cutover gate against a candidate that nothing points at yet.
#
# THE 2026-09-05 LESSON IS THE REASON THE CONFIG GATE EXISTS. media-ingest
# refused to boot on `TRANSLATION_ROUTES_DOCUMENT is required in production`,
# a guard inside an `isProduction` branch that staging -- running
# C7_ENVIRONMENT=staging -- can never evaluate. A fully certified staging wave
# proved nothing about it. The only thing that could find it was starting the
# candidate against the real production environment file, and the only safe
# place to do that is here, before anything points at the candidate.
atomic_gate_candidate() {
  local candidate="$1"
  local failed=0

  if [ -n "${ATOMIC_FN_PREFLIGHT:-}" ]; then
    echo "gate: production configuration preflight"
    if ! "$ATOMIC_FN_PREFLIGHT" "$candidate" "${ATOMIC_ENV_FILE:-}"; then
      echo "REFUSED: the candidate does not satisfy this environment's own startup rules." >&2
      echo "  Staging cannot prove these: they live behind an isProduction branch." >&2
      failed=1
    fi
  fi

  if [ -n "${ATOMIC_UNITS:-}" ]; then
    echo "gate: effective systemd configuration"
    # shellcheck disable=SC2086
    assert_units_resolve_through_pointer "$ATOMIC_CURRENT" $ATOMIC_UNITS || failed=1
    # shellcheck disable=SC2086
    assert_restart_limiter $ATOMIC_UNITS || failed=1
  fi

  return "$failed"
}

# Build and seal a release WITHOUT publishing it.
#
# EXPOSED AS A REAL OPERATION because the one-time convergence has to build the
# first release before `current` exists, and an earlier draft of the runbook
# told the operator to "run the preparation alone" while offering no command
# for it. An operator following that would source internals and improvise, and
# an improvised first release is the one nothing later can verify.
#
# It moves no pointer, touches no unit, restarts nothing.
atomic_prepare_only() {
  local sha="$1" ref="$2"
  atomic_lock_acquire || return 1
  assert_safe_path 'RELEASES_DIR' "$ATOMIC_RELEASES" || return 1
  assert_full_sha 'requested sha' "$sha" || return 1

  __atomic_prepare_body() {
    "$ATOMIC_FN_BUILD" "$1" || return 1
    # The UNIT gate is deliberately skipped here and only here: before
    # convergence the units still name the app tree, so requiring them to
    # resolve through `current` would make it impossible to build the very
    # release the convergence needs. The CONFIGURATION gate still runs, because
    # that one is about the release rather than about the host's systemd.
    if [ -n "${ATOMIC_FN_PREFLIGHT:-}" ]; then
      echo "gate: production configuration preflight"
      "$ATOMIC_FN_PREFLIGHT" "$1" "${ATOMIC_ENV_FILE:-}" || return 1
    fi
    return 0
  }
  release_prepare "$ATOMIC_RELEASES" "$sha" "$ref" __atomic_prepare_body || return 1
  echo "PREPARED $sha"
  echo "  nothing points at it: current -> $(pointer_target "$ATOMIC_CURRENT")"
  return 0
}

# The whole deployment, in the one order that keeps the invariant.
atomic_deploy() {
  local sha="$1" ref="$2"

  # ONE TRANSACTION OWNER. Held for the whole deployment, not just the rename:
  # two concurrent deploys would publish over each other and then each fail its
  # own running-release proof because the other's services are up.
  atomic_lock_acquire || return 1
  ATOMIC_LOCK_HELD=1

  assert_release_paths "$ATOMIC_ROOT" "$ATOMIC_RELEASES" "$ATOMIC_CURRENT" "$ATOMIC_WWW" || return 1
  assert_full_sha 'requested sha' "$sha" || return 1

  local previous
  previous="$(pointer_sha "$ATOMIC_CURRENT" "$ATOMIC_RELEASES")"
  echo "previous release: $previous"

  # ---------------------------------------------------------------- prepare
  # Everything below happens inside a directory nothing resolves. An external
  # restart at any point here boots `$previous`, unchanged.
  __atomic_prepare_body() {
    "$ATOMIC_FN_BUILD" "$1" || return 1
    # The gates run INSIDE preparation, so a candidate that fails one is never
    # sealed and therefore can never be published, rolled back to, or mistaken
    # for a release by a later deploy.
    atomic_gate_candidate "$1" || return 1
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
  # From here a failure is a ROLLBACK rather than a refusal. The previous
  # release is still sealed on disk, so going back is a rename plus a restart.
  local stage
  if ! __atomic_activate "$sha"; then
    echo "DEPLOY FAILED after publication; rolling back to $previous" >&2
    atomic_rollback_transition "$previous"
    return 1
  fi

  # ------------------------------------------------------------- finalise
  #
  # RECORDED ONLY AFTER THE SMOKE, WHICHEVER MACHINE RUNS IT.
  #
  # This used to write DEPLOY-STATE and print DEPLOYED here, and on production
  # the public smoke runs on the CALLER -- so the box announced a completed
  # deployment, and left a success record behind, while the smoke had not yet
  # been attempted. Anything reading that state during the gap, including the
  # rollback path's own "previous release" lookup, was reading a claim nobody
  # had earned.
  #
  # When the smoke belongs to the caller, this returns having activated but not
  # finalised, and the caller calls `atomic_finalize` once the edge answers.
  if [ -z "${ATOMIC_FN_SMOKE:-}" ]; then
    echo "ACTIVATED $sha (awaiting public smoke; NOT yet recorded)"
    return 0
  fi
  atomic_finalize "$sha" "$previous"
  return 0
}

# The last step, and the only place a deployment is called finished.
#
# Separate from `atomic_deploy` so the public smoke can run wherever it has to
# -- the edge is reachable from the operator's machine, not from the box -- and
# the record still cannot be written before it passes.
atomic_finalize() {
  local sha="$1" previous="$2"
  #
  # A STALE FINALIZE MUST REFUSE, NOT OVERWRITE.
  #
  # This runs after the caller's public smoke, which takes time. If anything
  # has moved underneath it -- another transaction published, the release was
  # corrupted, a service is running something else -- then recording success
  # would write a DEPLOY-STATE that names a release which is not current, and
  # every later rollback would read that as the last good one.
  #
  # The transaction lock is what makes this rare. These checks are what make it
  # impossible, because a lock proves ownership and not that the world stood
  # still.
  local live
  live="$(pointer_sha "$ATOMIC_CURRENT" "$ATOMIC_RELEASES")"
  if [ "$live" != "$sha" ]; then
    echo "REFUSED to finalise $sha: current now names $live." >&2
    echo "  Something published while this transaction was verifying. NOTHING has" >&2
    echo "  been recorded; DEPLOY-STATE still describes the last completed deploy." >&2
    return 1
  fi
  if ! release_is_complete "$(release_dir "$ATOMIC_RELEASES" "$sha")"; then
    echo "REFUSED to finalise $sha: its bytes no longer match the seal." >&2
    return 1
  fi
  if [ -n "${ATOMIC_FN_RUNNING:-}" ] && ! "$ATOMIC_FN_RUNNING" "$sha"; then
    echo "REFUSED to finalise $sha: the processes are not running it." >&2
    return 1
  fi
  atomic_record_state "$sha" "$previous"
  echo "DEPLOYED $sha"
}

# Restart, health, running-release proof, public smoke -- in that order.
#
# SHARED BY DEPLOYMENT AND ROLLBACK, so a rollback cannot quietly be held to a
# weaker standard than the deployment it is undoing. That asymmetry is exactly
# how a rollback comes to mean "the pointer moved" while nothing was verified.
#
# LOOPBACK HEALTH IS NOT ENOUGH, which is why SMOKE is in this list. A service
# can answer 200 on 127.0.0.1 while the public edge serves a stale shell or
# refuses a route; the deploy is not finished until the routes the public
# actually uses answer.
__atomic_activate() {
  local sha="$1"
  if [ -n "${ATOMIC_FN_RESTART:-}" ] && ! "$ATOMIC_FN_RESTART"; then
    echo "  activation failed: restart" >&2; return 1
  fi
  if [ -n "${ATOMIC_FN_HEALTH:-}" ] && ! "$ATOMIC_FN_HEALTH"; then
    echo "  activation failed: loopback health" >&2; return 1
  fi
  if [ -n "${ATOMIC_FN_RUNNING:-}" ] && ! "$ATOMIC_FN_RUNNING" "$sha"; then
    echo "  activation failed: processes are not running $sha" >&2; return 1
  fi
  if [ -n "${ATOMIC_FN_SMOKE:-}" ] && ! "$ATOMIC_FN_SMOKE"; then
    echo "  activation failed: public smoke" >&2; return 1
  fi
  return 0
}

# Return to a previous release COMPLETELY, not just on paper.
#
# A POINTER MOVE IS NOT A ROLLBACK. This used to move `current` back, print
# "RESTART THE SERVICES" and exit zero -- so the command reported success while
# every process was still executing the release it had just rolled away from.
# The operator was told to finish the job by hand at exactly the moment a
# half-finished state is most expensive, and any automation reading the exit
# code would have believed the system was restored.
#
# The transition is owned here, end to end, and the exit code means what it
# says: pointer moved, services restarted, health passing, processes proven to
# be running the rollback release, public edge answering.
atomic_rollback_transition() {
  local target="$1"
  # Taken unless the caller already owns it -- a rollback triggered from inside
  # a failed deployment is part of that same transaction, and `flock` on an
  # already-held descriptor in the same process would deadlock against itself.
  if [ "${ATOMIC_LOCK_HELD:-0}" != "1" ]; then
    atomic_lock_acquire || return 1
    ATOMIC_LOCK_HELD=1
  fi
  case "$target" in
    none|unmanaged:*|'')
      echo "CANNOT ROLL BACK: previous release is '${target:-none}'." >&2
      echo "  current -> $(pointer_target "$ATOMIC_CURRENT")" >&2
      echo "  This host has no earlier sealed release to return to." >&2
      return 1 ;;
  esac

  echo "rolling back to $target"
  if ! release_rollback "$ATOMIC_RELEASES" "$target" "$ATOMIC_CURRENT"; then
    echo "ROLLBACK FAILED at the pointer; current -> $(pointer_target "$ATOMIC_CURRENT")" >&2
    return 1
  fi
  echo "  pointer: current -> $(pointer_target "$ATOMIC_CURRENT")"

  if ! __atomic_activate "$target"; then
    # LOUD, AND WITH THE STATE SPELLED OUT. The one thing an operator cannot
    # act on is a rollback that failed without saying where it stopped.
    echo "ROLLBACK INCOMPLETE for $target." >&2
    echo "  pointer:   current -> $(pointer_target "$ATOMIC_CURRENT")" >&2
    echo "  a restart from here would boot: $(pointer_sha "$ATOMIC_CURRENT" "$ATOMIC_RELEASES")" >&2
    echo "  processes: NOT proven to be running $target" >&2
    release_state "$ATOMIC_RELEASES" "$ATOMIC_CURRENT" "$ATOMIC_WWW" >&2
    return 1
  fi

  if [ -z "${ATOMIC_FN_SMOKE:-}" ]; then
    # Same rule as a deployment: a rollback is not complete until the public
    # edge answers, and the record must not claim otherwise in the meantime.
    echo "ROLLED BACK to $target (awaiting public smoke; NOT yet recorded)"
    return 0
  fi
  atomic_record_state "$target" "rolled-back"
  echo "ROLLED BACK to $target"
  return 0
}

# What is live, what it replaced, and where to go back to.
atomic_record_state() {
  local sha="$1" previous="$2"
  local file="$ATOMIC_ROOT/DEPLOY-STATE.md"
  local tmp="$file.tmp.$$"
  {
    printf '# Deployment state\n\n'
    printf 'Written by the deploy. The pointer below is the authority; a git\n'
    printf 'checkout under this root is not.\n\n'
    printf '| | |\n|---|---|\n'
    printf '| active | `%s` |\n' "$sha"
    printf '| previous | `%s` |\n' "$previous"
    printf '| release path | `%s/%s` |\n' "$ATOMIC_RELEASES" "$sha"
    printf '| cutover (UTC) | %s |\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '\n## Rolling back\n\n'
    printf 'The previous release is still sealed on disk, so no rebuild is\n'
    printf 'needed. The command performs the WHOLE transition -- pointer,\n'
    printf 'restart, health, running-release proof and public smoke -- rather\n'
    printf 'than moving a pointer and leaving you to finish it:\n\n'
    printf '```\nbash deploy/atomic-deploy.sh %s rollback <sha>\n```\n\n' "${ATOMIC_ENV:-production}"
    printf '## Pointers\n\n```\n'
    release_state "$ATOMIC_RELEASES" "$ATOMIC_CURRENT" "$ATOMIC_WWW"
    printf '```\n'
  } > "$tmp"
  mv -f "$tmp" "$file"
}
