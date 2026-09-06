#!/usr/bin/env bash
# @author masterzee001
#
# Does the deployment engine actually keep its promise?
#
# The promise is one sentence: AT EVERY INSTANT, A SERVICE THAT RESTARTS BOOTS
# A RELEASE THAT PASSED EVERY GATE. Everything below is an attempt to catch it
# not being true.
#
# WHY THIS RUNS AGAINST A REAL FILESYSTEM. The properties being tested are
# filesystem properties -- that a rename replaces a symlink without an interval
# where it is missing, that a failed build leaves a pointer untouched, that a
# release directory is absent or complete and never half. A mock of the
# filesystem would be a mock of the thing under test, and would pass whatever
# its author believed. So every case runs in a real disposable tree under
# $TMPDIR and reads back what is actually on disk.
#
# HOW A RESTART IS SIMULATED. A service restarting resolves its
# WorkingDirectory through the pointer and boots whatever it finds. So
# `simulate_restart` resolves the pointer and reports the SHA -- which is
# precisely what the real thing does, and is the reason these assertions mean
# something about production rather than about the harness.
#
# The suite is written to FAIL when a guard is removed. `--mutate <name>`
# disables one guard and the run must go red; that is checked by
# `--prove-mutations`, because a test that cannot fail is not evidence.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib"
MUTATION="${MUTATION:-none}"

# REFUSE TO RUN WHERE THE SEMANTICS ARE NOT REAL.
#
# Everything here rests on two POSIX guarantees: `ln -s` makes a symlink, and
# rename(2) replaces one atomically. Git Bash on Windows emulates `ln -s` by
# COPYING, so `current` becomes a directory, the publish degenerates into a
# recursive move, and the suite reports failures that say nothing about the
# engine -- or worse, could be "fixed" into passing and prove nothing at all.
#
# The deployment target is Linux. A green run on a host that cannot express the
# mechanism is not weaker evidence, it is no evidence, so this refuses rather
# than warns.
__probe="$(mktemp -d "${TMPDIR:-/tmp}/videofy-symlink-probe-XXXXXX")"
mkdir -p "$__probe/target"
ln -s "$__probe/target" "$__probe/link" 2>/dev/null
if [ ! -L "$__probe/link" ]; then
  rm -rf "$__probe"
  echo "REFUSED: this environment does not create real symlinks." >&2
  echo "  The deployment engine is symlink-and-rename; testing it here would" >&2
  echo "  measure the emulation, not the engine. Run on the Linux target." >&2
  exit 2
fi
ln -sfn "$__probe/target" "$__probe/link2"
if ! mv -Tf "$__probe/link2" "$__probe/link" 2>/dev/null || [ ! -L "$__probe/link" ]; then
  rm -rf "$__probe"
  echo "REFUSED: 'mv -T' does not replace a symlink atomically here." >&2
  exit 2
fi
rm -rf "$__probe"

PASS=0; FAIL=0; FAILED_CASES=""

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED_CASES="$FAILED_CASES
  - $1"; printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

check()      { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
check_fails() { if "$@" >/dev/null 2>&1; then bad "$1 should have refused" ""; else ok "$1 refuses"; fi; }

# ---------------------------------------------------------------- the rig

new_rig() {
  RIG="$(mktemp -d "${TMPDIR:-/tmp}/videofy-deploy-XXXXXX")"
  export ATOMIC_ROOT="$RIG/srv"
  export ATOMIC_RELEASES="$ATOMIC_ROOT/releases"
  export ATOMIC_CURRENT="$ATOMIC_ROOT/current"
  export ATOMIC_WWW="$ATOMIC_ROOT/www"
  export ATOMIC_ENV=test
  export STUB_SYSTEMD_DIR="$RIG/systemd"
  export SYSTEMCTL="$HERE/stub-systemctl.sh"
  mkdir -p "$ATOMIC_RELEASES" "$STUB_SYSTEMD_DIR" "$RIG/proc"
  # STRUCTURAL, installed once, exactly as the one-time convergence does. It is
  # never touched again -- if a deployment moves it, that is the split-release
  # defect returning and the tests below are what catch it.
  ln -sfn "$ATOMIC_CURRENT/www" "$ATOMIC_WWW"
  # A converged host: units resolve through the pointer, with a real limiter.
  unit_fixture videofy-test-account "$ATOMIC_CURRENT/services/account"
  unit_fixture videofy-test-gateway "$ATOMIC_CURRENT/services/realtime-gateway"
  UNITS="videofy-test-account videofy-test-gateway"
  export ATOMIC_UNITS="$UNITS"
  export ATOMIC_ENV_FILE="$RIG/env"
  ATOMIC_FN_BUILD=build_body
  ATOMIC_FN_PREFLIGHT=preflight_body
  ATOMIC_FN_RESTART=restart_body
  ATOMIC_FN_HEALTH=health_body
  ATOMIC_FN_RUNNING=running_body
  ATOMIC_FN_SMOKE=smoke_body
  [ "${ATOMIC_FN_SMOKE_DISABLED:-0}" = "1" ] && ATOMIC_FN_SMOKE=""
  for u in $UNITS; do printf 'none' > "$RIG/proc/$u"; done
}

unit_fixture() {
  local unit="$1" wd="$2" user="${3:-videofy}"
  printf '%s' "$wd"    > "$STUB_SYSTEMD_DIR/$unit.WorkingDirectory"
  printf '%s' "$user"  > "$STUB_SYSTEMD_DIR/$unit.User"
  printf '10min'       > "$STUB_SYSTEMD_DIR/$unit.StartLimitIntervalUSec"
  printf '10'          > "$STUB_SYSTEMD_DIR/$unit.StartLimitBurst"
  : > "$STUB_SYSTEMD_DIR/$unit.DropInPaths"
}

drop_rig() {
  # THE HARNESS IS ONE PROCESS RUNNING MANY DEPLOYMENTS. Every operation takes
  # the lock and, in real life, gives it back by exiting. Here nothing exits,
  # so the suite must hand it back explicitly between cases -- otherwise the
  # first case owns it forever and the concurrency test waits on a holder that
  # can never acquire. That hung the run, and it was the harness, not the lock.
  atomic_lock_release 2>/dev/null || true
  [ -n "${RIG:-}" ] && rm -rf "$RIG"
}

sha_of() { printf '%040d' "$1" | tr '0123456789' 'abcdef0123'; }

# A build that writes a release the way the real one would.
BUILD_SHOULD_FAIL=0
WEB_SHOULD_FAIL=0
build_body() {
  local candidate="$1"
  mkdir -p "$candidate/services/account" "$candidate/services/realtime-gateway"
  printf '%s' "$BUILD_SHA" > "$candidate/BUILT_SHA"
  [ "$BUILD_SHOULD_FAIL" = "1" ] && return 1
  mkdir -p "$candidate/www/call-web"
  printf 'bundle-%s' "$BUILD_SHA" > "$candidate/www/call-web/index.html"
  # A workspace link of the shape npm creates, so integrity is tested against
  # what this monorepo actually ships rather than against files alone.
  mkdir -p "$candidate/node_modules/@videofy-live" "$candidate/packages/pkg"
  printf 'pkg' > "$candidate/packages/pkg/index.js"
  ln -sfn ../../packages/pkg "$candidate/node_modules/@videofy-live/pkg"
  [ "$WEB_SHOULD_FAIL" = "1" ] && return 1
  return 0
}

PREFLIGHT_SHOULD_FAIL=0
preflight_body() { [ "$PREFLIGHT_SHOULD_FAIL" = "1" ] && return 1; return 0; }

# A REAL PROCESS-STATE MODEL, because "what a restart would boot" and "what is
# currently serving" are different facts. A rollback that only moves the
# pointer satisfies the first while failing the second, and the suite could not
# see the difference until each unit had a process of its own to model. Each
# unit has a file holding the release it is executing; only a restart changes it.
RESTART_SHOULD_FAIL=0
RESTART_ONLY_FIRST=0
restart_body() {
  [ "$RESTART_SHOULD_FAIL" = "1" ] && return 1
  local now u first=1
  now="$(cat "$ATOMIC_CURRENT/BUILT_SHA" 2>/dev/null || echo none)"
  for u in $UNITS; do
    # A PARTIAL ROLL: the first unit takes the new release and the rest do not,
    # which is the mixture an interrupted restart actually leaves behind.
    if [ "$RESTART_ONLY_FIRST" = "1" ] && [ "$first" = "0" ]; then continue; fi
    printf '%s' "$now" > "$RIG/proc/$u"
    first=0
  done
  [ "$RESTART_ONLY_FIRST" = "1" ] && return 1
  return 0
}

HEALTH_SHOULD_FAIL=0
health_body() { [ "$HEALTH_SHOULD_FAIL" = "1" ] && return 1; return 0; }

# The proof the pointer cannot give: every process is executing $1.
RUNNING_SHOULD_FAIL=0
running_body() {
  [ "$RUNNING_SHOULD_FAIL" = "1" ] && return 1
  local expected="$1" u
  for u in $UNITS; do
    [ "$(cat "$RIG/proc/$u" 2>/dev/null)" = "$expected" ] || return 1
  done
  return 0
}

SMOKE_SHOULD_FAIL=0
smoke_body() { [ "$SMOKE_SHOULD_FAIL" = "1" ] && return 1; return 0; }

# What every process is ACTUALLY executing right now, as a sorted unique list.
#
# One value means every service agrees; two means a mixture, which is the state
# a pointer-only rollback leaves behind and which no pointer check can see.
serving_now() {
  local u
  for u in $UNITS; do cat "$RIG/proc/$u" 2>/dev/null || echo none; echo; done \
    | grep -v '^$' | sort -u | paste -sd, -
}

# WHAT A RESTARTING SERVICE WOULD BOOT, resolved the way systemd resolves it.
simulate_restart() {
  local wd="$ATOMIC_CURRENT/services/account"
  [ -d "$wd" ] || { printf 'NOTHING'; return; }
  cat "$ATOMIC_CURRENT/BUILT_SHA" 2>/dev/null || printf 'NOTHING'
}
# Caddy resolves `root` per request, so this reads through the structural
# pointer exactly as a visitor's request does: www -> current/www -> release.
simulate_web_request() {
  cat "$ATOMIC_WWW/call-web/index.html" 2>/dev/null || printf 'NOTHING'
}

# What the structural pointer literally says. It must name `current`, never a
# release, on every host and after every deployment.
web_pointer_target() { readlink "$ATOMIC_WWW" 2>/dev/null || printf 'NOT-A-SYMLINK'; }

deploy() {
  local sha="$1" rc
  BUILD_SHA="$sha"
  atomic_deploy "$sha" "$sha"
  rc=$?
  # Handed back immediately, for the same reason as in drop_rig.
  atomic_lock_release 2>/dev/null || true
  ATOMIC_LOCK_HELD=0
  return "$rc"
}

reset_failures() {
  BUILD_SHOULD_FAIL=0; WEB_SHOULD_FAIL=0; PREFLIGHT_SHOULD_FAIL=0
  RESTART_SHOULD_FAIL=0; RESTART_ONLY_FIRST=0; HEALTH_SHOULD_FAIL=0
  RUNNING_SHOULD_FAIL=0; SMOKE_SHOULD_FAIL=0
}

# shellcheck source=../lib/atomic-release.sh
. "$LIB/atomic-release.sh"
# shellcheck source=../lib/transaction.sh
. "$LIB/transaction.sh"
# Sourced HERE, above the mutation block, so a mutation that redefines one of
# its functions is not silently undone by a later re-source inside a test --
# which is exactly why `preflight-as-deploy-user` appeared to survive.
. "$LIB/activation.sh"

# Mutations disable exactly one guard, to prove the suite can see it go.
if [ "$MUTATION" = "no-seal-check" ]; then
  release_is_complete() { [ -d "$1" ]; }
fi
if [ "$MUTATION" = "publish-before-gates" ]; then
  atomic_gate_candidate() { return 0; }
fi
if [ "$MUTATION" = "non-atomic-pointer" ]; then
  # The `rm` then `ln` pattern this engine exists to avoid.
  #
  # THE SLEEP IS NOT A CHEAT, it is what makes the mutant representative. A
  # real non-atomic publish has a window in which the pointer does not exist;
  # on an idle machine that window is microseconds, which a shell observer
  # would miss almost every time -- and a test that only sometimes catches a
  # defect is a test that reports the defect as fixed. Widening the window to
  # something a shell can see does not change WHICH implementations pass: an
  # atomic publish has no window at any granularity and passes regardless of
  # how closely it is watched, while any implementation with a window fails.
  pointer_publish() { rm -f "$1"; sleep 0.02; ln -s "$2" "$1"; }
fi
if [ "$MUTATION" = "no-path-guard" ]; then
  assert_release_paths() { return 0; }
  path_is_within() { return 0; }
fi
if [ "$MUTATION" = "two-release-pointers" ]; then
  # The design this milestone was sent back to fix: `www` moved as its own
  # release pointer, with a gap between the two renames. Each rename is atomic
  # and the PAIR is not, which is the entire point.
  release_publish() {
    local releases="$1" sha="$2" current="$3"
    local dir; dir="$(release_dir "$releases" "$sha")" || return 1
    release_is_complete "$dir" || return 1
    pointer_publish "$current" "$dir" || return 1
    sleep 0.02
    pointer_publish "$ATOMIC_WWW" "$dir/www"
  }
fi
if [ "$MUTATION" = "rollback-pointer-only" ]; then
  # The defect the CTO caught: rollback moves the pointer, says "restart the
  # services", and exits zero while every process runs the abandoned release.
  atomic_rollback_transition() {
    release_rollback "$ATOMIC_RELEASES" "$1" "$ATOMIC_CURRENT" || return 1
    echo "RESTART THE SERVICES"
    return 0
  }
fi
if [ "$MUTATION" = "no-smoke" ]; then
  # Deployment stops at loopback health, as it did before the correction.
  ATOMIC_FN_SMOKE_DISABLED=1
fi
if [ "$MUTATION" = "no-integrity" ]; then
  # A release is trusted because it carries a marker, not because its bytes
  # still match. Tampering then survives publication and rollback.
  release_integrity_holds() { return 0; }
fi
if [ "$MUTATION" = "no-full-sha-rule" ]; then
  assert_full_sha() { return 0; }
fi
if [ "$MUTATION" = "prepare-publishes" ]; then
  # `prepare` quietly becomes a deployment.
  atomic_prepare_only() {
    local sha="$1" ref="$2"
    __atomic_prepare_body() { "$ATOMIC_FN_BUILD" "$1"; }
    release_prepare "$ATOMIC_RELEASES" "$sha" "$ref" __atomic_prepare_body || return 1
    release_publish "$ATOMIC_RELEASES" "$sha" "$ATOMIC_CURRENT"
  }
fi
if [ "$MUTATION" = "finalize-before-smoke" ]; then
  # The defect: record and announce success before the edge is asked.
  __atomic_activate() {
    local sha="$1"
    [ -n "${ATOMIC_FN_RESTART:-}" ] && ! "$ATOMIC_FN_RESTART" && return 1
    [ -n "${ATOMIC_FN_HEALTH:-}" ] && ! "$ATOMIC_FN_HEALTH" && return 1
    [ -n "${ATOMIC_FN_RUNNING:-}" ] && ! "$ATOMIC_FN_RUNNING" "$sha" && return 1
    atomic_record_state "$sha" "pre-smoke"
    [ -n "${ATOMIC_FN_SMOKE:-}" ] && ! "$ATOMIC_FN_SMOKE" && return 1
    return 0
  }
fi
if [ "$MUTATION" = "symlink-not-sealed" ]; then
  # Content-only manifest: files hashed, symlinks invisible.
  release_manifest_of() {
    ( cd "$1" && find . -type f -not -path './.git/*' -not -name 'RELEASE.json' \
        -not -name 'RELEASE.manifest.sha256' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum )
  }
fi
if [ "$MUTATION" = "move-active-release-aside" ]; then
  # Rename the live release out from under `current` during preparation.
  release_prepare() {
    local releases="$1" sha="$2" ref="$3" body="$4"
    local final="$releases/$sha" candidate="$releases/.candidate-$sha.$$"
    if [ -e "$final" ] && ! release_is_complete "$final"; then
      mv -T "$final" "$final.unverified.$(date -u +%s)" || return 1
    elif [ -e "$final" ]; then return 0; fi
    mkdir -p "$candidate" && "$body" "$candidate" || return 1
    release_seal "$candidate" "$sha" "$ref" test
    mv -T "$candidate" "$final"
  }
fi
if [ "$MUTATION" = "no-deploy-lock" ]; then
  atomic_lock_acquire() { return 0; }
fi
if [ "$MUTATION" = "lock-not-held-through-smoke" ]; then
  # The defect: external ownership is ignored, so the lock is only held for as
  # long as each individual operation runs -- and a competing transaction can
  # slip in during the caller-side smoke.
  atomic_lock_acquire() { return 0; }
fi
if [ "$MUTATION" = "stale-finalize-allowed" ]; then
  atomic_finalize() { atomic_record_state "$1" "$2"; echo "DEPLOYED $1"; }
fi
if [ "$MUTATION" = "no-symlink-containment" ]; then
  release_symlinks_stay_inside() { return 0; }
fi
if [ "$MUTATION" = "ship-before-lock" ]; then
  # The defect: machinery is installed first and ownership checked afterwards,
  # so a caller that loses has already overwritten the winner's libraries.
  transaction_begin() {
    local lock_fn="$1" ship_fn="$2"
    "$ship_fn" || return 1
    "$lock_fn" || return 1
    return 0
  }
fi
if [ "$MUTATION" = "shared-remote-lib" ]; then
  # The defect: every transaction computes the SAME machinery directory, so one
  # caller writes where another reads.
  transaction_nonce() { printf 'shared'; }
fi
if [ "$MUTATION" = "no-engine-provenance" ]; then
  # The defect: production accepts a working-tree engine, so a certified SHA
  # can be qualified by uncommitted operator-side code.
  engine_is_committed() { git -C "$1" rev-parse HEAD 2>/dev/null; return 0; }
fi
if [ "$MUTATION" = "preflight-as-deploy-user" ]; then
  # The defect: the preflight accepts whatever identity it is handed, including
  # none, instead of proving it is the one systemd actually boots with.
  activation_preflight() { return 0; }
fi
if [ "$MUTATION" = "no-dropin-guard" ]; then
  assert_units_resolve_through_pointer() { return 0; }
fi

A="$(sha_of 1)"; B="$(sha_of 2)"; C="$(sha_of 3)"

# ============================================================ path guards

echo "path validation"
check_fails assert_safe_path 'empty' ''
check_fails assert_safe_path 'relative' 'srv/app'
check_fails assert_safe_path 'root' '/'
check_fails assert_safe_path 'dotdot' '/srv/../etc'
check_fails assert_safe_path 'trailing' '/srv/app/'
check_fails assert_safe_path 'double' '/srv//app'

# THE MATCH-ALL. An empty parent must never accept an arbitrary child; that is
# the exact shape the previous guard shipped with.
if path_is_within '' '/srv/videofy-prod/release-980619e/services/x'; then
  bad "empty parent must not match everything" "it matched"
else ok "empty parent matches nothing"; fi

# THE PREFIX LOOKALIKE. `app-old` is not inside `app`.
if path_is_within '/srv/videofy-prod/app' '/srv/videofy-prod/app-old/services/x'; then
  bad "prefix lookalike must not be 'within'" "it matched"
else ok "prefix lookalike refused"; fi

if path_is_within '/srv/videofy-prod/app' '/srv/videofy-prod/app/services/x'; then
  ok "a real child is within"
else bad "a real child must be within" "it did not match"; fi

check_fails assert_full_sha 'short' 'abc123'
check_fails assert_full_sha 'branch name' 'main'
check_fails assert_full_sha 'traversal' '../../etc/passwd'

new_rig
check_fails assert_release_paths '' "$ATOMIC_RELEASES" "$ATOMIC_CURRENT" "$ATOMIC_WWW"
check_fails assert_release_paths "$ATOMIC_ROOT" "$ATOMIC_RELEASES" "$ATOMIC_RELEASES" "$ATOMIC_WWW"
check_fails assert_release_paths "$ATOMIC_ROOT" "$ATOMIC_RELEASES" "$ATOMIC_CURRENT" "$ATOMIC_CURRENT"
check_fails assert_release_paths "$ATOMIC_ROOT" "$ATOMIC_RELEASES" '/elsewhere/current' "$ATOMIC_WWW"
drop_rig

# ============================================ the restart invariant, in order

echo ""
echo "the restart invariant"

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
check "first deploy publishes" "$(simulate_restart)" "$A"
check "web serves the first release" "$(simulate_web_request)" "bundle-$A"

# B is prepared while A is live. At every step below, a restart must still boot A.
BUILD_SHA="$B"
OBSERVED=""
observing_prepare() {
  build_body "$1" || return 1
  OBSERVED="$OBSERVED $(simulate_restart)"
  return 0
}
ATOMIC_FN_BUILD=observing_prepare
atomic_deploy "$B" "$B" >/dev/null 2>&1
ATOMIC_FN_BUILD=build_body
check "a restart DURING preparation boots the old release" "$(echo $OBSERVED)" "$A"
check "after publication a restart boots the new release" "$(simulate_restart)" "$B"
check "the old release is still on disk" \
  "$(release_is_complete "$ATOMIC_RELEASES/$A" && echo yes || echo no)" "yes"
drop_rig

# ------------------------------------------------- a failed gate publishes nothing

echo ""
echo "a failed gate never moves the pointer"

for stage in build web preflight; do
  new_rig; reset_failures
  deploy "$A" >/dev/null 2>&1
  case "$stage" in
    build) BUILD_SHOULD_FAIL=1 ;;
    web) WEB_SHOULD_FAIL=1 ;;
    preflight) PREFLIGHT_SHOULD_FAIL=1 ;;
  esac
  deploy "$B" >/dev/null 2>&1
  check "$stage failure leaves the old release booting" "$(simulate_restart)" "$A"
  check "$stage failure leaves the old bundle served" "$(simulate_web_request)" "bundle-$A"
  check "$stage failure seals no release for B" \
    "$(release_is_complete "$ATOMIC_RELEASES/$B" && echo yes || echo no)" "no"
  drop_rig
done

# --------------------------------------------------- systemd refusals

echo ""
echo "effective systemd configuration"

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
# Unit drift: a unit points somewhere the pointer does not govern.
unit_fixture videofy-test-gateway "/srv/videofy-prod/release-980619e/services/realtime-gateway"
deploy "$B" >/dev/null 2>&1
check "unit drift refuses before cutover" "$(simulate_restart)" "$A"
drop_rig

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
# A drop-in that redirects WorkingDirectory -- the 2026-09-05 incident shape.
mkdir -p "$RIG/dropins"
printf '[Service]\nWorkingDirectory=/srv/videofy-prod/release-980619e/services/account\n' \
  > "$RIG/dropins/10-release.conf"
printf '%s' "$RIG/dropins/10-release.conf" > "$STUB_SYSTEMD_DIR/videofy-test-account.DropInPaths"
deploy "$B" >/dev/null 2>&1
check "a WorkingDirectory drop-in refuses before cutover" "$(simulate_restart)" "$A"
check "the drop-in is NOT removed by the deploy" \
  "$([ -f "$RIG/dropins/10-release.conf" ] && echo present || echo gone)" "present"
drop_rig

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
# An ordinary drop-in that does not touch WorkingDirectory must be allowed.
mkdir -p "$RIG/dropins"
printf '[Service]\nEnvironment=X=1\n' > "$RIG/dropins/10-env.conf"
printf '%s' "$RIG/dropins/10-env.conf" > "$STUB_SYSTEMD_DIR/videofy-test-account.DropInPaths"
deploy "$B" >/dev/null 2>&1
check "an unrelated drop-in does not block a deploy" "$(simulate_restart)" "$B"
drop_rig

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
printf '0' > "$STUB_SYSTEMD_DIR/videofy-test-account.StartLimitBurst"
deploy "$B" >/dev/null 2>&1
check "a missing restart limiter refuses before cutover" "$(simulate_restart)" "$A"
drop_rig

# --------------------------------------------------- post-cutover failures

echo ""
echo "failures after the boundary roll back"

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
RESTART_SHOULD_FAIL=1
deploy "$B" >/dev/null 2>&1
check "a failed restart rolls the pointer back to A" "$(simulate_restart)" "$A"
check "rollback needed no rebuild" \
  "$(release_is_complete "$ATOMIC_RELEASES/$A" && echo yes || echo no)" "yes"
check "B remains sealed and available" \
  "$(release_is_complete "$ATOMIC_RELEASES/$B" && echo yes || echo no)" "yes"
drop_rig

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
HEALTH_SHOULD_FAIL=1
deploy "$B" >/dev/null 2>&1
check "a failed health verify rolls back to A" "$(simulate_restart)" "$A"
check "web rolled back with it" "$(simulate_web_request)" "bundle-$A"
drop_rig

# --------------------------------------------------- rollback as a transition

echo ""
echo "rollback"

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
deploy "$B" >/dev/null 2>&1
atomic_rollback_transition "$A" >/dev/null 2>&1
check "explicit rollback returns to A" "$(simulate_restart)" "$A"
check "and returns the web assets too" "$(simulate_web_request)" "bundle-$A"
if atomic_rollback_transition "$C" >/dev/null 2>&1; then
  bad "rollback to a release this host never had" "it succeeded"
else ok "rollback to an unknown release refuses"; fi
drop_rig

# --------------------------------------------------- interrupted preparation

echo ""
echo "interruption and duplicate deployment"

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
# A directory with the right name and no seal: the wreckage of a killed deploy.
mkdir -p "$ATOMIC_RELEASES/$B/services"
printf 'garbage' > "$ATOMIC_RELEASES/$B/BUILT_SHA"
deploy "$B" >/dev/null 2>&1
check "an unsealed same-name directory is not reused" "$(simulate_restart)" "$B"
check "the unsealed directory was preserved, not deleted" \
  "$(ls -d "$ATOMIC_RELEASES/$B".unverified.* >/dev/null 2>&1 && echo kept || echo destroyed)" "kept"
drop_rig

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
deploy "$A" >/dev/null 2>&1
check "deploying the same sha twice is idempotent" "$(simulate_restart)" "$A"
drop_rig

# A candidate that is never sealed can never be published.
new_rig; reset_failures
mkdir -p "$ATOMIC_RELEASES/$C"
if release_publish "$ATOMIC_RELEASES" "$C" "$ATOMIC_CURRENT" >/dev/null 2>&1; then
  bad "an unsealed release was published" "publish succeeded"
else ok "an unsealed release cannot be published"; fi
drop_rig

# --------------------------------------------------- no missing-pointer window

echo ""
echo "publication leaves no interval with no pointer"

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" refs/test build_body >/dev/null 2>&1
# An observer sampling as fast as it can while the pointer is replaced. The
# property is not "the swap is quick"; it is that no sample ever finds the
# pointer missing or dangling.
# The observer samples continuously until told to stop, rather than for a fixed
# count that can finish before the publisher has even started.
MISSES=0
: > "$RIG/observations"
( while [ ! -f "$RIG/stop" ]; do
    if [ ! -e "$ATOMIC_CURRENT/BUILT_SHA" ]; then
      # RECORD WHAT WAS SEEN, not just that something was. A bare count turns a
      # rare miss into a mystery nobody can act on; these three facts say
      # whether the POINTER was absent (a real gap), whether it pointed at a
      # release that was not there, or whether the observer simply raced its
      # own `readlink`.
      printf 'miss link=[%s] linkexists=[%s] targetdir=[%s]
'         "$(readlink "$ATOMIC_CURRENT" 2>/dev/null || echo NOLINK)"         "$([ -L "$ATOMIC_CURRENT" ] && echo yes || echo no)"         "$([ -d "$ATOMIC_CURRENT/" ] && echo yes || echo no)"
    fi
  done > "$RIG/observations" ) &
OBSERVER=$!
for _ in $(seq 1 30); do
  release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1
  release_publish "$ATOMIC_RELEASES" "$A" "$ATOMIC_CURRENT" >/dev/null 2>&1
done
: > "$RIG/stop"
# Waited on by PID. A `pkill -f` here once matched the live staging service and
# stopped it; nothing in this suite ever kills by pattern.
wait "$OBSERVER" 2>/dev/null
# `grep -c` exits 1 when the count is zero, so `|| echo 0` would append a
# SECOND zero and the comparison would fail on the good outcome.
MISSES="$(grep -c miss "$RIG/observations" 2>/dev/null)"
[ -n "$MISSES" ] || MISSES=0
[ "$MISSES" -gt 0 ] && { echo "    observations:"; head -3 "$RIG/observations" | sed "s/^/      /"; }
check "no observation found the pointer missing" "$MISSES" "0"
drop_rig

# A seal that names a different commit than the directory it sits in.
#
# Found by an adversarial probe, not by the original suite: sealed-ness alone
# let a copied or hand-restored release be published under the wrong name, so
# `current` would point at releases/<A> holding B's bytes and every report
# would say A.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
mkdir -p "$ATOMIC_RELEASES/$C"
printf '{"sha": "%s", "complete": true}' "$B" > "$ATOMIC_RELEASES/$C/RELEASE.json"
if release_is_complete "$ATOMIC_RELEASES/$C"; then
  bad "a seal naming another commit was accepted" "it passed"
else ok "a seal that disagrees with its directory name is not a release"; fi
if release_publish "$ATOMIC_RELEASES" "$C" "$ATOMIC_CURRENT" >/dev/null 2>&1; then
  bad "a mis-sealed release was published" "publish succeeded"
else ok "a mis-sealed release cannot be published"; fi
check "and the pointer never moved" "$(simulate_restart)" "$A"
drop_rig

# --------------------------------------------------- killed mid-deployment

echo ""
echo "killed at the worst moments"

# I. Killed immediately BEFORE publication. Preparation completed and sealed,
#    the pointer never moved.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" refs/test build_body >/dev/null 2>&1
check "killed before publication: a restart still boots the old release" "$(simulate_restart)" "$A"
check "killed before publication: the old bundle is still served" "$(simulate_web_request)" "bundle-$A"
check "killed before publication: B is sealed and publishable later"   "$(release_is_complete "$ATOMIC_RELEASES/$B" && echo yes || echo no)" "yes"
# and finishing the job later needs no rebuild
release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1
check "the interrupted deployment completes without rebuilding" "$(simulate_restart)" "$B"
drop_rig

# J. Killed immediately AFTER publication, before the planned restart. The
#    services are still running the old code, but the pointer is authoritative:
#    any restart from here boots the new release, which passed every gate.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" refs/test build_body >/dev/null 2>&1
release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1
check "killed after publication: a restart boots the qualified new release" "$(simulate_restart)" "$B"
check "killed after publication: web is the new release too" "$(simulate_web_request)" "bundle-$B"
check "killed after publication: the old release is still there to return to"   "$(release_is_complete "$ATOMIC_RELEASES/$A" && echo yes || echo no)" "yes"
drop_rig

# Q. There is no longer a half-rolled-back state to interrupt.
#
#    This case used to publish `current` and `www` separately and assert the
#    two could be re-converged. That test documented the defect: it PASSED
#    while the system could serve release A's API next to release B's bundles.
#    With `www` structural there is no second pointer to desynchronise, so the
#    honest test is that the split is unreachable rather than recoverable.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
deploy "$B" >/dev/null 2>&1
atomic_rollback_transition "$A" >/dev/null 2>&1
check "rollback moves the API back" "$(simulate_restart)" "$A"
check "and the site came with it, in the same rename" "$(simulate_web_request)" "bundle-$A"
check "the web pointer still names current, not a release"   "$(web_pointer_target)" "$ATOMIC_CURRENT/www"
drop_rig

# R. The same SHA deployed while it is already live changes nothing.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BEFORE="$(pointer_target "$ATOMIC_CURRENT")"
deploy "$A" >/dev/null 2>&1
check "re-deploying the live sha leaves the pointer where it was"   "$(pointer_target "$ATOMIC_CURRENT")" "$BEFORE"
drop_rig

# ============================== one release boundary, not two

echo ""
echo "publication is ONE pointer move"

# THE REGRESSION THE CTO SENT THIS BACK FOR. Two individually atomic renames
# are not one atomic transaction: between them the API is release B and the
# site is still release A. An observer watching both must never catch them
# disagreeing.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
check "before: API is A" "$(simulate_restart)" "$A"
check "before: web is A" "$(simulate_web_request)" "bundle-$A"
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" refs/test build_body >/dev/null 2>&1

# THE OBSERVER MUST SAMPLE ONE INSTANT, NOT TWO.
#
# Two earlier attempts both failed as observers rather than as findings. The
# first read the API file and then the site file and reported 28 "splits"; the
# second read two `readlink -f` results. Both compared values captured at
# DIFFERENT moments, so a pointer that legitimately moved in between looked
# like a split. Adding reads never fixes that -- any multi-read observer of a
# moving target can manufacture a disagreement, and asserting on it would
# condemn a correct design.
#
# One read is enough, because the property is structural rather than temporal:
# `www` must literally say `current/www` and nothing else, ALWAYS. That is a
# constant. If it ever names a release, a second release pointer has been
# reintroduced and the atomic boundary is gone -- which is exactly what the
# `two-release-pointers` mutation does, and it is caught on the first sample.
: > "$RIG/split"
( while [ ! -f "$RIG/stop" ]; do
    [ "$(readlink "$ATOMIC_WWW" 2>/dev/null)" = "$ATOMIC_CURRENT/www" ] || echo split
  done > "$RIG/split" ) &  # observer for the structural-pointer check
SPLITOBS=$!
for _ in $(seq 1 30); do
  release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1
  release_publish "$ATOMIC_RELEASES" "$A" "$ATOMIC_CURRENT" >/dev/null 2>&1
done
: > "$RIG/stop"
wait "$SPLITOBS" 2>/dev/null
SPLITS="$(grep -c split "$RIG/split" 2>/dev/null)"; [ -n "$SPLITS" ] || SPLITS=0
check "the site never became a second release pointer, at any sample" "$SPLITS" "0"

deploy "$B" >/dev/null 2>&1
check "after: API is B" "$(simulate_restart)" "$B"
check "after: web is B" "$(simulate_web_request)" "bundle-$B"
check "a deployment never moved the structural web pointer"   "$(web_pointer_target)" "$ATOMIC_CURRENT/www"
check "and it still resolves through current"   "$(readlink -f "$ATOMIC_WWW" 2>/dev/null)" "$(readlink -f "$ATOMIC_RELEASES/$B/www" 2>/dev/null)"
drop_rig

# ============================== rolling process activation

echo ""
echo "atomic publication, ROLLING process activation"

# THE DOCTRINE, STATED HONESTLY. Publication is atomic; the processes are not.
# After the rename and before every planned restart completes, old and new
# processes coexist. These cases pin what that costs.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" refs/test build_body >/dev/null 2>&1

# 1. NEW web against OLD backend BEFORE publication -- impossible by
#    construction, because the candidate's assets are not reachable at all.
check "a candidate's bundles are not publicly reachable before publication"   "$(simulate_web_request)" "bundle-$A"

release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1

# 2/3. One service restarted, the others not: the mixture the CTO asked about.
#      A process that has not restarted is still executing A's code from an
#      open file handle, while anything starting now gets B.
check "after publication, a service that restarts gets B" "$(simulate_restart)" "$B"
check "the release A directory is still intact for processes holding it open"   "$(cat "$ATOMIC_RELEASES/$A/BUILT_SHA" 2>/dev/null)" "$A"

# 4. A planned restart fails while other services have already moved. The
#    pointer is unaffected by process state, so the recovery is the same
#    single rename regardless of how far the roll got.
atomic_rollback_transition "$A" >/dev/null 2>&1
check "rollback from a half-rolled restart returns everything to A" "$(simulate_restart)" "$A"
check "including the site, atomically" "$(simulate_web_request)" "bundle-$A"

# 5. Rollback from the mixed state must not need the failed release removed.
check "B remains sealed after rolling away from it"   "$(release_is_complete "$ATOMIC_RELEASES/$B" && echo yes || echo no)" "yes"
drop_rig

# An external restart of exactly ONE service immediately after publication.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" refs/test build_body >/dev/null 2>&1
release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1
# unattended-upgrades restarting one unit, which is what happened on 09-05.
check "an unplanned single-service restart lands on the QUALIFIED release"   "$(simulate_restart)" "$B"
# Resolved first: `release_is_complete` compares the seal against the directory
# NAME, and the pointer's own name is "current". Asking it about the symlink
# rather than its target tested nothing about the release.
check "it can never land on an unqualified one"   "$(release_is_complete "$(readlink "$ATOMIC_CURRENT")" && echo sealed || echo unsealed)" "sealed"
drop_rig

# ====================== rollback is a COMPLETE version transition

echo ""
echo "rollback moves processes, not just a pointer"

# THE DEFECT THIS SUITE COULD NOT SEE BEFORE. Rollback used to move `current`,
# print "RESTART THE SERVICES" and exit zero -- success, while every process
# still ran the release being abandoned. Without a process model the tests
# agreed, because they only ever asked what a restart WOULD boot.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
check "A is serving" "$(serving_now)" "$A"
RESTART_ONLY_FIRST=1
deploy "$B" >/dev/null 2>&1
check "partial restart then rollback: pointer is back on A" "$(simulate_restart)" "$A"
RESTART_ONLY_FIRST=0
check "and every process is running A, not a mixture" "$(serving_now)" "$A"
drop_rig

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
HEALTH_SHOULD_FAIL=1
deploy "$B" >/dev/null 2>&1
HEALTH_SHOULD_FAIL=0
check "health failure rolls the pointer back" "$(simulate_restart)" "$A"
check "health failure leaves every process on A" "$(serving_now)" "$A"
drop_rig

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
SMOKE_SHOULD_FAIL=1
deploy "$B" >/dev/null 2>&1
SMOKE_SHOULD_FAIL=0
check "public smoke failure rolls back the pointer" "$(simulate_restart)" "$A"
check "public smoke failure leaves every process on A" "$(serving_now)" "$A"
drop_rig

# A deployment must FAIL when smoke fails -- not publish and advise.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
SMOKE_SHOULD_FAIL=1
if deploy "$B" >/dev/null 2>&1; then
  bad "a smoke failure reported success" "exit 0"
else ok "a smoke failure fails the deployment"; fi
SMOKE_SHOULD_FAIL=0
drop_rig

# The rollback transition itself must fail loudly when it cannot complete.
for stage in restart health smoke; do
  new_rig; reset_failures
  deploy "$A" >/dev/null 2>&1
  deploy "$B" >/dev/null 2>&1
  case "$stage" in
    restart) RESTART_SHOULD_FAIL=1 ;;
    health)  HEALTH_SHOULD_FAIL=1 ;;
    smoke)   SMOKE_SHOULD_FAIL=1 ;;
  esac
  if atomic_rollback_transition "$A" >/dev/null 2>&1; then
    bad "rollback with failing $stage reported success" "exit 0"
  else ok "rollback fails loudly when $stage fails"; fi
  reset_failures
  drop_rig
done

# An explicit rollback that succeeds must move the processes too.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
deploy "$B" >/dev/null 2>&1
check "B is serving before rollback" "$(serving_now)" "$B"
atomic_rollback_transition "$A" >/dev/null 2>&1
check "explicit rollback: pointer on A" "$(simulate_restart)" "$A"
check "explicit rollback: processes on A" "$(serving_now)" "$A"
drop_rig

# ============================== release integrity, not just a label

echo ""
echo "a sealed release must still BE what was sealed"

# RELEASE.json proves a directory was once sealed and claims a SHA. It says
# nothing about whether the dist a service is about to execute, or the bundle a
# visitor is about to download, is still what passed the gates.
tamper_case() {
  local label="$1" action="$2"
  new_rig; reset_failures
  deploy "$A" >/dev/null 2>&1
  BUILD_SHA="$B"
  release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
  eval "$action"
  if release_is_complete "$ATOMIC_RELEASES/$B"; then
    bad "$label was still considered a release" "integrity passed"
  else ok "$label invalidates the release"; fi
  if release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1; then
    bad "$label could still be published" "publish succeeded"
  else ok "$label cannot be published"; fi
  if atomic_rollback_transition "$B" >/dev/null 2>&1; then
    bad "$label could still be rolled back to" "rollback succeeded"
  else ok "$label cannot be rolled back to"; fi
  check "$label left the pointer on A" "$(simulate_restart)" "$A"
  drop_rig
}
tamper_case "a changed dist file"   'printf tampered > "$ATOMIC_RELEASES/$B/BUILT_SHA"'
tamper_case "a changed web bundle"  'printf tampered > "$ATOMIC_RELEASES/$B/www/call-web/index.html"'
tamper_case "a missing file"        'rm -f "$ATOMIC_RELEASES/$B/www/call-web/index.html"'
tamper_case "an added runtime file" 'printf x > "$ATOMIC_RELEASES/$B/services/account/extra.js"'
tamper_case "a deleted manifest"    'rm -f "$ATOMIC_RELEASES/$B/RELEASE.manifest.sha256"'

# An untouched release stays reusable -- integrity must not be so strict that
# an ordinary redeploy of the same SHA is refused.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
check "an unchanged sealed release is still reusable"   "$(release_is_complete "$ATOMIC_RELEASES/$B" && echo yes || echo no)" "yes"
drop_rig

# ============================== prepare-only

echo ""
echo "prepare builds a release and publishes nothing"

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
atomic_prepare_only "$B" "$B" >/dev/null 2>&1
check "prepare sealed the release"   "$(release_is_complete "$ATOMIC_RELEASES/$B" && echo yes || echo no)" "yes"
check "prepare did not move the pointer" "$(simulate_restart)" "$A"
check "prepare did not change what is serving" "$(serving_now)" "$A"
check "prepare did not touch the structural web pointer"   "$(web_pointer_target)" "$ATOMIC_CURRENT/www"
# And the prepared release is publishable later with no rebuild.
release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1
check "the prepared release publishes later without rebuilding" "$(simulate_restart)" "$B"
drop_rig

# Prepare must work BEFORE convergence, when units still name the app tree.
new_rig; reset_failures
unit_fixture videofy-test-account /srv/videofy-prod/app/services/account
unit_fixture videofy-test-gateway /srv/videofy-prod/app/services/realtime-gateway
BUILD_SHA="$A"
if atomic_prepare_only "$A" "$A" >/dev/null 2>&1; then
  ok "prepare works on an unconverged host, where units still name the app tree"
else bad "prepare refused on an unconverged host" "it must not"; fi
drop_rig

# ============================== the converged unit contract

echo ""
echo "the runbook's unit source actually resolves through current"

# THE RUNBOOK WAS FALSE. It told operators to install
# deploy/production/systemd/<unit>.service for the converged state, while those
# files still name /srv/videofy-prod/app -- so following it exactly would have
# converged the pointer and left every unit reading the old tree.
REPO="$HERE/../.."
for unit in videofy-prod-account videofy-prod-gateway videofy-prod-media-ingest; do
  converged="$REPO/deploy/production/systemd-converged/$unit.service"
  legacy="$REPO/deploy/production/systemd/$unit.service"
  wd="$(grep -E '^WorkingDirectory=' "$converged" 2>/dev/null | head -1 | cut -d= -f2-)"
  case "$wd" in
    /srv/videofy-prod/current/services/*)
      ok "$unit converged unit resolves through current" ;;
    *) bad "$unit converged unit does not use the pointer" "WorkingDirectory=$wd" ;;
  esac
  # The legacy twin must KEEP naming the app tree: deploy.sh reconciles from
  # that directory, and if it named `current` the legacy deploy would install
  # current-based units on a host where `current` does not exist yet.
  lwd="$(grep -E '^WorkingDirectory=' "$legacy" 2>/dev/null | head -1 | cut -d= -f2-)"
  case "$lwd" in
    /srv/videofy-prod/app/services/*)
      ok "$unit legacy unit still names the app tree" ;;
    *) bad "$unit legacy unit was changed" "WorkingDirectory=$lwd" ;;
  esac
done
# And the two directories must be different files, or the separation is a lie.
if diff -q "$REPO/deploy/production/systemd/videofy-prod-account.service"            "$REPO/deploy/production/systemd-converged/videofy-prod-account.service" >/dev/null 2>&1; then
  bad "converged and legacy units are identical" "the migration would be a no-op"
else ok "converged and legacy units are genuinely different"; fi

# The gate accepts the converged contract and refuses the legacy one.
new_rig; reset_failures
unit_fixture videofy-test-account "$ATOMIC_CURRENT/services/account"
if assert_units_resolve_through_pointer "$ATOMIC_CURRENT" videofy-test-account >/dev/null 2>&1; then
  ok "a current-based unit satisfies the gate"
else bad "a current-based unit was refused" "it must pass"; fi
unit_fixture videofy-test-account /srv/videofy-prod/app/services/account
if assert_units_resolve_through_pointer "$ATOMIC_CURRENT" videofy-test-account >/dev/null 2>&1; then
  bad "an app-tree unit satisfied the gate" "it must be refused"
else ok "an app-tree unit is refused before cutover"; fi
drop_rig

# ============================== the locked production SHA rule

echo ""
echo "production takes only a full 40-character SHA"

# A branch is a moving target and a tag is a label somebody can repoint;
# neither is a statement about which bytes were approved.
for bad_ref in main v1.2.3 abc1234 HEAD "" "../../etc/passwd" "$(printf '%041d' 1 | tr 0 a)"; do
  if assert_full_sha 'production ref' "$bad_ref" >/dev/null 2>&1; then
    bad "production accepted '$bad_ref'" "it must be refused"
  else ok "production refuses '${bad_ref:-<empty>}'"; fi
done
# NOT a counter-example, though it looked like one when this test was written:
# forty DECIMAL digits are also forty valid lowercase HEX digits, so that string
# is a well-formed SHA and must be ACCEPTED. Listing it among the refusals was a
# test bug, and the suite caught it rather than the engine being wrong.
if assert_full_sha 'production ref' "$(printf '%040d' 1)" >/dev/null 2>&1; then
  ok "forty digits is valid hex and is accepted"
else bad "a forty-digit SHA was refused" "digits are hex"; fi
if assert_full_sha 'production ref' "$A" >/dev/null 2>&1; then
  ok "production accepts a full lowercase 40-char SHA"
else bad "a valid full SHA was refused" ""; fi
# Uppercase is refused too: the whole chain is written in lowercase, and
# accepting both would make two spellings of one release.
if assert_full_sha 'production ref' "$(printf '%s' "$A" | tr 'a-f' 'A-F')" >/dev/null 2>&1; then
  bad "an uppercase SHA was accepted" "one release must have one spelling"
else ok "an uppercase SHA is refused"; fi

# ============================== finalise only after the smoke

echo ""
echo "success is recorded only after the public edge answers"

state_file() { printf '%s/DEPLOY-STATE.md' "$ATOMIC_ROOT"; }
recorded_active() { sed -n 's/^| active | .\(.*\). |$/\1/p' "$(state_file)" 2>/dev/null | head -1; }

# THE DEFECT: the record was written after health and the running proof but
# BEFORE the smoke, so a deployment the edge never confirmed still left a
# success behind -- which the rollback path then read as "the previous good
# release".
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
check "a completed deploy records A" "$(recorded_active)" "$A"
SMOKE_SHOULD_FAIL=1
deploy "$B" >/dev/null 2>&1
SMOKE_SHOULD_FAIL=0
check "a smoke failure never records B" "$(recorded_active)" "$A"
check "and the pointer rolled back to A" "$(simulate_restart)" "$A"
check "and the processes are on A" "$(serving_now)" "$A"
drop_rig

# The record must not exist even momentarily before the smoke. Proved from
# INSIDE the smoke callback, which runs before finalisation.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
SEEN_DURING_SMOKE=""
smoke_body() { SEEN_DURING_SMOKE="$(recorded_active)"; return 0; }
deploy "$B" >/dev/null 2>&1
check "DEPLOY-STATE still named A while the smoke ran" "$SEEN_DURING_SMOKE" "$A"
check "and names B only after the smoke passed" "$(recorded_active)" "$B"
smoke_body() { [ "$SMOKE_SHOULD_FAIL" = "1" ] && return 1; return 0; }
drop_rig

# Rollback obeys the same rule.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
deploy "$B" >/dev/null 2>&1
SMOKE_SHOULD_FAIL=1
atomic_rollback_transition "$A" >/dev/null 2>&1
SMOKE_SHOULD_FAIL=0
check "a rollback whose smoke fails never records success" "$(recorded_active)" "$B"
drop_rig

# ============================== symlink integrity

echo ""
echo "the seal covers the runtime namespace, not just file contents"

# A WORKSPACE LINK IS RUNTIME. Repointing node_modules/@videofy-live/x changes
# which code executes while every ordinary file hash stays identical, so a
# content-only manifest seals nothing that matters in this monorepo.
link_case() {
  local label="$1" action="$2"
  new_rig; reset_failures
  deploy "$A" >/dev/null 2>&1
  BUILD_SHA="$B"
  release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
  eval "$action"
  if release_is_complete "$ATOMIC_RELEASES/$B"; then
    bad "$label was still considered a release" "integrity passed"
  else ok "$label invalidates the release"; fi
  if release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1; then
    bad "$label could still be published" "publish succeeded"
  else ok "$label cannot be published"; fi
  drop_rig
}
link_case "a repointed symlink" \
  'ln -sfn ../../packages/other "$ATOMIC_RELEASES/$B/node_modules/@videofy-live/pkg"'
link_case "a deleted symlink" \
  'rm -f "$ATOMIC_RELEASES/$B/node_modules/@videofy-live/pkg"'
link_case "an added symlink" \
  'ln -sfn ../../packages/pkg "$ATOMIC_RELEASES/$B/node_modules/@videofy-live/extra"'

new_rig; reset_failures
BUILD_SHA="$A"
release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1
check "an untouched release with workspace symlinks stays valid" \
  "$(release_is_complete "$ATOMIC_RELEASES/$A" && echo yes || echo no)" "yes"
check "and its symlinks resolve inside the release" \
  "$(release_symlinks_stay_inside "$ATOMIC_RELEASES/$A" 2>/dev/null && echo inside || echo escapes)" "inside"
ln -sfn /etc "$ATOMIC_RELEASES/$A/node_modules/@videofy-live/escape"
check "a link pointing outside the release is refused" \
  "$(release_symlinks_stay_inside "$ATOMIC_RELEASES/$A" 2>/dev/null && echo inside || echo escapes)" "escapes"
drop_rig

# ============================== never move the ACTIVE release aside

echo ""
echo "a corrupt ACTIVE release is an incident, not a redeploy"

# THE HAZARD: preparation used to rename an integrity-failing same-SHA
# directory out of the way. If `current` points at it, that leaves the pointer
# DANGLING before any replacement exists -- an external restart in that window
# boots nothing, the one thing this engine promises cannot happen.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
printf 'corrupted' > "$ATOMIC_RELEASES/$A/BUILT_SHA"
BUILD_SHA="$A"
if release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1; then
  bad "preparing over the corrupt ACTIVE release succeeded" "it must refuse"
else ok "preparing over a corrupt ACTIVE release refuses"; fi
check "current still exists" "$([ -L "$ATOMIC_CURRENT" ] && echo yes || echo no)" "yes"
check "current still points at A" \
  "$(pointer_target "$ATOMIC_CURRENT")" "$ATOMIC_RELEASES/$A"
check "a restart still resolves something, never NOTHING" \
  "$([ -e "$ATOMIC_CURRENT/BUILT_SHA" ] && echo resolves || echo NOTHING)" "resolves"
check "nothing was moved aside" \
  "$(ls -d "$ATOMIC_RELEASES/$A".unverified.* 2>/dev/null | wc -l | tr -d ' ')" "0"
if deploy "$A" >/dev/null 2>&1; then
  bad "deploying over the corrupt ACTIVE release succeeded" "it must refuse"
else ok "deploying over a corrupt ACTIVE release refuses"; fi
check "and current is still A afterwards" \
  "$(pointer_target "$ATOMIC_CURRENT")" "$ATOMIC_RELEASES/$A"
drop_rig

# A corrupt NON-ACTIVE release may still be moved aside and rebuilt.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
printf 'corrupted' > "$ATOMIC_RELEASES/$B/BUILT_SHA"
release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
check "a corrupt NON-active release is rebuilt cleanly" \
  "$(release_is_complete "$ATOMIC_RELEASES/$B" && echo yes || echo no)" "yes"
check "and the corrupt one was preserved" \
  "$(ls -d "$ATOMIC_RELEASES/$B".unverified.* >/dev/null 2>&1 && echo kept || echo destroyed)" "kept"
drop_rig

# ============================== one deployment at a time

echo ""
echo "mutating operations are serialised by a kernel-owned lock"

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
# A REAL COMPETING PROCESS, not a simulated one: the whole point is that the
# lock belongs to a process and is released when that process dies.
printf '%s\n' \
  ". \"$LIB/deploy-lock.sh\"" \
  "export ATOMIC_ROOT=\"$ATOMIC_ROOT\"" \
  "atomic_lock_acquire || exit 9" \
  "touch \"$RIG/held\"" \
  "for _ in \$(seq 1 200); do [ -f \"$RIG/release\" ] && break; sleep 0.05; done" > "$RIG/holder.sh"
# The suite's own lock is handed back first: without this the holder can never
# acquire, and the wait below would spin forever.
atomic_lock_release 2>/dev/null || true
ATOMIC_LOCK_HELD=0
# setsid so the holder owns a process GROUP. An `flock` is held by the open
# file description, which children inherit -- killing only the parent leaves a
# `sleep` holding the lock, which is exactly what happened the first time this
# test was written. A dying deployment takes its children with it, so the test
# must model that rather than a single orphaned parent.
setsid bash "$RIG/holder.sh" &
HOLDER_PID=$!
# BOUNDED. A wait with no ceiling is how a test harness leaves processes
# spinning on a shared host; if the holder never signals, fail the case rather
# than hang the run.
HOLDER_READY=no
for _ in $(seq 1 100); do
  [ -f "$RIG/held" ] && { HOLDER_READY=yes; break; }
  sleep 0.05
done
if [ "$HOLDER_READY" != yes ]; then
  bad "the competing lock holder never started" "cannot test serialisation"
fi

BUILD_SHA="$B"
if atomic_prepare_only "$B" "$B" >/dev/null 2>&1; then
  bad "prepare ran while another operation held the lock" "it must refuse"
else ok "prepare refuses while the lock is held"; fi
if deploy "$B" >/dev/null 2>&1; then
  bad "deploy ran while another operation held the lock" "it must refuse"
else ok "deploy refuses while the lock is held"; fi
if atomic_rollback_transition "$A" >/dev/null 2>&1; then
  bad "rollback ran while another operation held the lock" "it must refuse"
else ok "rollback refuses while the lock is held"; fi

# KILLED, not asked to exit: the lock must be released by the kernel rather
# than by cleanup code a crash would skip.
# Killed by process GROUP, never by a `-f` pattern: a pattern kill in a test
# harness once matched and stopped the live staging service.
HOLDER_PGID="$(ps -o pgid= -p "$HOLDER_PID" 2>/dev/null | tr -d ' ')"
[ -n "$HOLDER_PGID" ] && kill -9 -"$HOLDER_PGID" 2>/dev/null
kill -9 "$HOLDER_PID" 2>/dev/null
wait "$HOLDER_PID" 2>/dev/null
# The kernel releases on process exit; give the group a moment to actually go.
for _ in $(seq 1 40); do
  flock -n "$ATOMIC_ROOT/.deploy.lock" true 2>/dev/null && break
  sleep 0.05
done
BUILD_SHA="$B"
if atomic_prepare_only "$B" "$B" >/dev/null 2>&1; then
  ok "the lock is released when the holding process is killed"
else bad "the lock survived the holder being killed" "stale lock"; fi
atomic_lock_release 2>/dev/null || true
if atomic_prepare_only "$B" "$B" >/dev/null 2>&1; then
  ok "the lock is released after a successful operation"
else bad "the lock was not released after success" ""; fi
atomic_lock_release 2>/dev/null || true
drop_rig

# `state` is read-only and must never block on the lock.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
if release_state "$ATOMIC_RELEASES" "$ATOMIC_CURRENT" "$ATOMIC_WWW" >/dev/null 2>&1; then
  ok "state reads without taking the lock"
else bad "state failed" ""; fi
drop_rig

# ============================== the lock spans the whole transaction

echo ""
echo "the transaction lock covers smoke and finalisation, not just activation"

# THE DEFECT: the box released the lock when its activation command exited, and
# the caller then ran the public smoke and finalised with no lock at all. A
# second deployment could publish in that window, and the first would finalise
# DEPLOY-STATE naming a release that was no longer current.
#
# Modelled here by holding the lock in an OUTER process for the whole
# transaction -- exactly what the caller-side holder session does -- and
# checking that a competing operation is refused while the smoke is running.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1

# An outer owner, whose lifetime is the whole transaction.
printf '%s\n' \
  ". \"$LIB/deploy-lock.sh\"" \
  "export ATOMIC_ROOT=\"$ATOMIC_ROOT\"" \
  "atomic_lock_acquire || exit 9" \
  "touch \"$RIG/owned\"" \
  "for _ in \$(seq 1 400); do [ -f \"$RIG/done\" ] && break; sleep 0.05; done" > "$RIG/owner.sh"
atomic_lock_release 2>/dev/null || true
ATOMIC_LOCK_HELD=0
setsid bash "$RIG/owner.sh" &
OWNER_PID=$!
for _ in $(seq 1 100); do [ -f "$RIG/owned" ] && break; sleep 0.05; done
check "the transaction owner holds the lock" \
  "$([ -f "$RIG/owned" ] && echo yes || echo no)" "yes"

# The inner operations run under the owner's authority, exactly as the remote
# half does when the caller holds the lock.
ATOMIC_LOCK_EXTERNAL=1
BUILD_SHA="$B"
if atomic_prepare_only "$B" "$B" >/dev/null 2>&1; then
  ok "an operation under the transaction owner proceeds"
else bad "the owned operation was refused" "external ownership not honoured"; fi
unset ATOMIC_LOCK_EXTERNAL

# A DIFFERENT transaction -- one that does not own it -- must still be refused
# for the whole window, which is what "spans the smoke" means.
if atomic_prepare_only "$C" "$C" >/dev/null 2>&1; then
  bad "a competing prepare ran during the transaction" "it must refuse"
else ok "a competing prepare is refused for the whole transaction"; fi
if deploy "$C" >/dev/null 2>&1; then
  bad "a competing deploy ran during the transaction" "it must refuse"
else ok "a competing deploy is refused for the whole transaction"; fi
if atomic_rollback_transition "$A" >/dev/null 2>&1; then
  bad "a competing rollback ran during the transaction" "it must refuse"
else ok "a competing rollback is refused for the whole transaction"; fi

# KILLED MID-SMOKE: the lock must come back through process-tree ownership, and
# no success may have been fabricated in the meantime.
OWNER_PGID="$(ps -o pgid= -p "$OWNER_PID" 2>/dev/null | tr -d ' ')"
[ -n "$OWNER_PGID" ] && kill -9 -"$OWNER_PGID" 2>/dev/null
kill -9 "$OWNER_PID" 2>/dev/null
wait "$OWNER_PID" 2>/dev/null
for _ in $(seq 1 40); do
  flock -n "$ATOMIC_ROOT/.deploy.lock" true 2>/dev/null && break
  sleep 0.05
done
check "a transaction killed mid-smoke recorded no success" "$(recorded_active)" "$A"
BUILD_SHA="$C"
if atomic_prepare_only "$C" "$C" >/dev/null 2>&1; then
  ok "the lock returns after the owning transaction is killed"
else bad "the lock survived the transaction being killed" "stale lock"; fi
atomic_lock_release 2>/dev/null || true
drop_rig

# ============================== a stale finalise refuses

echo ""
echo "finalisation proves the world did not move"

# Finalisation runs after the caller's smoke, which takes time. A lock proves
# ownership, not that nothing changed -- so the record is written only if the
# release it names is still the live one, still intact, and still running.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
# B was never published: current still names A.
if atomic_finalize "$B" "$A" >/dev/null 2>&1; then
  bad "finalised a release that is not current" "it must refuse"
else ok "finalising a release that is not current refuses"; fi
check "and DEPLOY-STATE still names A" "$(recorded_active)" "$A"

# Published, then corrupted before finalisation.
release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1
printf 'tampered' > "$ATOMIC_RELEASES/$B/BUILT_SHA"
if atomic_finalize "$B" "$A" >/dev/null 2>&1; then
  bad "finalised a release whose bytes changed" "it must refuse"
else ok "finalising a corrupted release refuses"; fi
check "DEPLOY-STATE still names A after that too" "$(recorded_active)" "$A"
drop_rig

# Published and intact, but the processes are running something else.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1
if atomic_finalize "$B" "$A" >/dev/null 2>&1; then
  bad "finalised while the processes ran the old release" "it must refuse"
else ok "finalising without the processes on the release refuses"; fi
check "and nothing was recorded" "$(recorded_active)" "$A"
drop_rig

# ============================== symlink containment is release authority

echo ""
echo "a release that reaches outside itself is not a release"

new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
# An escaping link present at build time must stop the seal being written.
escaping_build() {
  build_body "$1" || return 1
  ln -sfn /etc/passwd "$1/node_modules/@videofy-live/outside"
  return 0
}
BUILD_SHA="$B"
if release_prepare "$ATOMIC_RELEASES" "$B" "$B" escaping_build >/dev/null 2>&1; then
  bad "a release with an escaping link was sealed" "it must refuse"
else ok "an escaping link stops the release being sealed"; fi
check "no marker was written" \
  "$([ -f "$ATOMIC_RELEASES/$B/RELEASE.json" ] && echo yes || echo no)" "no"
check "and the pointer never moved" "$(simulate_restart)" "$A"
drop_rig

# A relative escape is refused on the same terms as an absolute one.
new_rig; reset_failures
relative_escape_build() {
  build_body "$1" || return 1
  ln -sfn ../../../../etc "$1/node_modules/@videofy-live/up"
  return 0
}
BUILD_SHA="$B"
if release_prepare "$ATOMIC_RELEASES" "$B" "$B" relative_escape_build >/dev/null 2>&1; then
  bad "a relative ../../ escape was sealed" "it must refuse"
else ok "a relative escape is refused too"; fi
drop_rig

# Added after sealing: the release stops being valid for every use.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
ln -sfn /etc "$ATOMIC_RELEASES/$B/node_modules/@videofy-live/late"
if release_is_complete "$ATOMIC_RELEASES/$B"; then
  bad "an escaping link added after sealing was ignored" "still valid"
else ok "an escaping link added after sealing invalidates the release"; fi
if release_publish "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1; then
  bad "an escaped release was published" "publish succeeded"
else ok "an escaped release cannot be published"; fi
if atomic_rollback_transition "$B" >/dev/null 2>&1; then
  bad "an escaped release was rolled back to" "rollback succeeded"
else ok "an escaped release cannot be rolled back to"; fi
drop_rig

# An internal link repointed OUTSIDE after sealing.
new_rig; reset_failures
deploy "$A" >/dev/null 2>&1
BUILD_SHA="$B"
release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
ln -sfn /etc/hostname "$ATOMIC_RELEASES/$B/node_modules/@videofy-live/pkg"
if release_is_complete "$ATOMIC_RELEASES/$B"; then
  bad "an internal link repointed outside was ignored" "still valid"
else ok "an internal link repointed outside invalidates the release"; fi
drop_rig

# And the ordinary case still passes: relative workspace links stay inside.
new_rig; reset_failures
BUILD_SHA="$A"
release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1
check "a relative internal workspace symlink is fine" \
  "$(release_is_complete "$ATOMIC_RELEASES/$A" && echo yes || echo no)" "yes"
drop_rig

# ============================== the transaction bootstrap

echo ""
echo "nothing is installed on the host before the lock is owned"

# THE DEFECT: the deploy shipped its libraries to a SHARED remote path and only
# then tried to take the lock. A caller about to lose the race had already
# replaced the executable machinery the winner was running from -- so
# serialising the release pointer bought nothing, because the code doing the
# serialising could be swapped underneath it.
new_rig; reset_failures

SHIPPED=""
record_ship() { SHIPPED="$SHIPPED ship"; return 0; }
lock_ok()   { return 0; }
lock_busy() { echo "REFUSED: another deployment operation holds the lock." >&2; return 1; }

SHIPPED=""
if transaction_begin lock_busy record_ship >/dev/null 2>&1; then
  bad "a losing caller was allowed to proceed" "transaction_begin returned 0"
else ok "a caller that cannot take the lock is refused"; fi
check "and it shipped NOTHING to the host" "$(echo $SHIPPED)" ""

SHIPPED=""
if transaction_begin lock_ok record_ship >/dev/null 2>&1; then
  ok "a caller that owns the lock proceeds"
else bad "the winning caller was refused" ""; fi
check "and only then does it ship" "$(echo $SHIPPED)" "ship"

# A failing ship is a failed transaction, not a half-installed one.
ship_fails() { return 1; }
if transaction_begin lock_ok ship_fails >/dev/null 2>&1; then
  bad "a failed install reported success" ""
else ok "a transaction whose machinery will not install refuses"; fi
drop_rig

echo ""
echo "each transaction runs from machinery only it can write"

# Two callers, modelled the way the real ones behave: each computes its own
# private remote directory from a nonce, and the loser is refused before it can
# write anything at all.
new_rig; reset_failures
B_LIB="$RIG/lib-$(transaction_nonce)"
C_LIB="$RIG/lib-$(transaction_nonce)"
check "two transactions choose different machinery directories" \
  "$([ "$B_LIB" != "$C_LIB" ] && echo different || echo SAME)" "different"

# B installs its machinery under the lock and records its exact contents.
mkdir -p "$B_LIB"; printf 'engine-B' > "$B_LIB/release-engine.sh"
B_BEFORE="$(sha256sum "$B_LIB/release-engine.sh" | cut -d' ' -f1)"

# C arrives with DIFFERENT library contents and loses the lock.
C_SHIPPED=""
c_ship() { C_SHIPPED="shipped"; mkdir -p "$C_LIB"; printf 'engine-C' > "$C_LIB/release-engine.sh"; return 0; }
if transaction_begin lock_busy c_ship >/dev/null 2>&1; then
  bad "the losing caller installed its machinery" "it must refuse first"
else ok "the losing caller is refused before installing anything"; fi
check "the loser wrote nothing at all" "$C_SHIPPED" ""
check "B's machinery is byte-identical" \
  "$(sha256sum "$B_LIB/release-engine.sh" | cut -d' ' -f1)" "$B_BEFORE"
check "and the loser created no directory B could consume" \
  "$([ -e "$C_LIB" ] && echo created || echo none)" "none"

# Even when C DOES own a lock later, it cannot reach B's directory, because the
# name it computes is its own.
transaction_begin lock_ok c_ship >/dev/null 2>&1
check "C installs only into its own directory" \
  "$(cat "$C_LIB/release-engine.sh" 2>/dev/null)" "engine-C"
check "B's machinery is still untouched" \
  "$(cat "$B_LIB/release-engine.sh" 2>/dev/null)" "engine-B"
drop_rig

# The real script must not contain a host write before the lock. Checked
# against the file because the ordering IS the property, and a comment saying
# so is not the same as the call sequence saying so.
new_rig; reset_failures
SCRIPT="$HERE/../atomic-deploy.sh"
FIRST_SHIP="$(grep -n 'transaction_begin hold_transaction_lock ship_engine' "$SCRIPT" | head -1 | cut -d: -f1)"
BARE_SHIP="$(grep -nE '^[[:space:]]*ship_engine([^(]|$)' "$SCRIPT" | grep -v transaction_begin | head -1 | cut -d: -f1)"
check "mutating paths install machinery only through transaction_begin" \
  "$([ -n "$FIRST_SHIP" ] && echo yes || echo no)" "yes"
# The one bare call is `state`, which is read-only and takes no lock.
check "the only unlocked ship is the read-only state path" \
  "$(sed -n "$((BARE_SHIP-8)),${BARE_SHIP}p" "$SCRIPT" | grep -c 'READ-ONLY')" "1"
drop_rig

# ============================== real-host transport findings

echo ""
echo "the five things only a real deployment could find"

REPO_ROOT="$HERE/../.."
DEPLOY_SH="$REPO_ROOT/deploy/atomic-deploy.sh"

# A. BOOTSTRAP OWNERSHIP. The deployment root is root-owned and the deploy user
#    creates releases and takes the lock there. install.sh must create both, or
#    the first production preparation dies on "Permission denied" and reports
#    it as a busy lock.
if grep -q 'VIDEOFY_ROOT/releases' "$REPO_ROOT/deploy/production/install.sh"; then
  ok "install.sh creates the releases directory for the deploy user"
else bad "install.sh does not create releases/" "the first prepare cannot write"; fi
if grep -q 'deploy.lock' "$REPO_ROOT/deploy/production/install.sh"; then
  ok "install.sh creates the transaction lock file"
else bad "install.sh does not create the lock file" "a missing lock reads as a held lock"; fi

# B. BUNDLE TRANSPORT. `git bundle create <file> <sha>` refuses: a bundle
#    packages refs, not commits. Proven against real git rather than asserted.
new_rig; reset_failures
SRC="$RIG/src"; mkdir -p "$SRC"
git -C "$SRC" init -q .
git -C "$SRC" -c user.email=t@t -c user.name=t commit -q --allow-empty -m one
REAL_SHA="$(git -C "$SRC" rev-parse HEAD)"
if git -C "$SRC" bundle create "$RIG/bare.bundle" "$REAL_SHA" >/dev/null 2>&1; then
  bad "bundling a bare sha unexpectedly succeeded" "the guard would be pointless"
else ok "bundling a bare sha refuses, as the real failure did"; fi
git -C "$SRC" update-ref refs/deploy/t "$REAL_SHA"
if git -C "$SRC" bundle create "$RIG/ref.bundle" refs/deploy/t >/dev/null 2>&1; then
  ok "bundling a temporary ref succeeds"
else bad "bundling a ref failed" "the fix does not work"; fi
# And the far side can fetch it back to the exact commit.
DST="$RIG/dst"; mkdir -p "$DST"; git -C "$DST" init -q .
git -C "$DST" fetch -q "$RIG/ref.bundle" refs/deploy/t 2>/dev/null
git -C "$DST" checkout -q --detach FETCH_HEAD 2>/dev/null
check "the fetched commit is byte-identical to the requested sha" \
  "$(git -C "$DST" rev-parse HEAD 2>/dev/null)" "$REAL_SHA"
check "and the deploy ships by ref, not by bare sha" \
  "$(grep -c 'git bundle create "\$BUNDLE" "\$BUNDLE_REF"' "$DEPLOY_SH")" "1"
drop_rig

# C. LF TRANSPORT. A CRLF library is fatal on the host: bash reads the trailing
#    carriage return as part of the command.
new_rig; reset_failures
printf 'echo hello\r\necho world\r\n' > "$RIG/crlf.sh"
if bash "$RIG/crlf.sh" >/dev/null 2>&1; then
  ok "(this platform tolerates CRLF; the host does not, which is why we strip)"
else ok "a CRLF script fails to run, exactly as it did on the host"; fi
sed -i 's/\r$//' "$RIG/crlf.sh"
if bash "$RIG/crlf.sh" >/dev/null 2>&1; then
  ok "the same script runs once normalised to LF"
else bad "LF normalisation did not fix it" ""; fi
check "the deploy normalises what it ships" \
  "$(grep -c "sed -i 's/.r\$//'" "$DEPLOY_SH")" "1"
check "and it normalises a COPY, never the working tree" \
  "$(grep -c 'videofy-atomic-stage' "$DEPLOY_SH")" "1"
drop_rig

# D. PREFLIGHT IDENTITY -- TESTED BY BEHAVIOUR, NOT BY GREP.
#
# The first version of these two cases asserted that the SOURCE contained
# certain strings. Both mutations then SURVIVED at 223/223: replacing the
# function changes behaviour and not one character of the file, so a grep sees
# nothing. A test that cannot fail is not evidence, so these call the real
# functions and assert what they do.
new_rig; reset_failures

# No configured identity: refuse rather than guess. Guessing would test a user
# no service runs as, and pass.
ATOMIC_SERVICE_USER="" ATOMIC_UNITS="videofy-test-account" \
  activation_preflight "$RIG" "$RIG/env" >/dev/null 2>&1 \
  && bad "the preflight ran with no configured identity" "it must refuse" \
  || ok "the preflight refuses when no service identity is configured"

# Configured identity disagrees with systemd's effective User: refuse. A check
# run as the wrong user proves nothing about the real startup.
unit_fixture videofy-test-account "$ATOMIC_CURRENT/services/account" videofy
ATOMIC_SERVICE_USER="somebody-else" ATOMIC_UNITS="videofy-test-account" \
  activation_preflight "$RIG" "$RIG/env" >/dev/null 2>&1 \
  && bad "the preflight accepted an identity systemd does not use" "it must refuse" \
  || ok "the preflight refuses when the identity disagrees with the unit"

# The refusal must name the disagreement, or an operator cannot act on it.
PREFLIGHT_ERR="$(ATOMIC_SERVICE_USER="somebody-else" ATOMIC_UNITS="videofy-test-account" \
  activation_preflight "$RIG" "$RIG/env" 2>&1 || true)"
case "$PREFLIGHT_ERR" in
  *"runs as 'videofy'"*) ok "and says which identity systemd actually uses" ;;
  *) bad "the refusal does not name the effective user" "$PREFLIGHT_ERR" ;;
esac
drop_rig

# E. ENGINE PROVENANCE -- ALSO BY BEHAVIOUR.
new_rig; reset_failures
ENGREPO="$RIG/engine"
mkdir -p "$ENGREPO/deploy/lib"
git -C "$ENGREPO" init -q .
printf 'committed\n' > "$ENGREPO/deploy/lib/activation.sh"
git -C "$ENGREPO" add -A >/dev/null 2>&1
git -C "$ENGREPO" -c user.email=t@t -c user.name=t commit -q -m engine

ENG_SHA="$(engine_is_committed "$ENGREPO" 2>/dev/null)"
check "a clean committed engine reports its sha" \
  "$([ -n "$ENG_SHA" ] && echo reported || echo none)" "reported"
check "and the sha is the engine's HEAD" \
  "$ENG_SHA" "$(git -C "$ENGREPO" rev-parse HEAD)"

# A modified tracked deploy file: exactly the state this incident created.
printf 'edited locally\n' >> "$ENGREPO/deploy/lib/activation.sh"
if engine_is_committed "$ENGREPO" >/dev/null 2>&1; then
  bad "a modified activation.sh was accepted" "production could run uncommitted code"
else ok "a modified deploy file refuses"; fi
git -C "$ENGREPO" checkout -q -- deploy/lib/activation.sh

# A modified preflight, named specifically because it is the file that decides
# whether production configuration is acceptable.
printf 'x\n' >> "$ENGREPO/deploy/lib/preflight-config.mjs" 2>/dev/null || \
  printf 'x\n' > "$ENGREPO/deploy/lib/preflight-config.mjs"
if engine_is_committed "$ENGREPO" >/dev/null 2>&1; then
  bad "an uncommitted preflight-config.mjs was accepted" "the gate itself is unversioned"
else ok "an untracked preflight-config.mjs refuses"; fi
rm -f "$ENGREPO/deploy/lib/preflight-config.mjs"

# An untracked executable beside the committed engine.
printf 'evil\n' > "$ENGREPO/deploy/lib/extra.sh"
if engine_is_committed "$ENGREPO" >/dev/null 2>&1; then
  bad "an untracked deploy/lib file was accepted" "shipped bytes would be unversioned"
else ok "an untracked file under deploy/lib refuses"; fi
rm -f "$ENGREPO/deploy/lib/extra.sh"

# Clean again: the gate must not be permanently sticky.
if engine_is_committed "$ENGREPO" >/dev/null 2>&1; then
  ok "a re-cleaned engine is accepted again"
else bad "the gate stayed refused after cleaning" ""; fi

# A directory that is not a Git repository at all cannot identify itself.
mkdir -p "$RIG/notgit/deploy"
if engine_is_committed "$RIG/notgit" >/dev/null 2>&1; then
  bad "a non-repository was accepted as an engine" "it has no sha to record"
else ok "an engine with no Git HEAD refuses"; fi
drop_rig

# ============================================================ report

echo ""
echo "-------------------------------------------------------------"
printf 'passed %s   failed %s\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'failing cases:%s\n' "$FAILED_CASES"
  exit 1
fi
exit 0
