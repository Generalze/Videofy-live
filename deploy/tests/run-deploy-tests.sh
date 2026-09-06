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
  mkdir -p "$ATOMIC_RELEASES" "$STUB_SYSTEMD_DIR"
  # STRUCTURAL, installed once, exactly as the one-time convergence does. It is
  # never touched again -- if a deployment moves it, that is the split-release
  # defect returning and the tests below are what catch it.
  ln -sfn "$ATOMIC_CURRENT/www" "$ATOMIC_WWW"
  # A converged host: units resolve through the pointer, with a real limiter.
  unit_fixture videofy-test-account "$ATOMIC_CURRENT/services/account"
  unit_fixture videofy-test-gateway "$ATOMIC_CURRENT/services/realtime-gateway"
  UNITS="videofy-test-account videofy-test-gateway"
}

unit_fixture() {
  local unit="$1" wd="$2"
  printf '%s' "$wd"    > "$STUB_SYSTEMD_DIR/$unit.WorkingDirectory"
  printf '10min'       > "$STUB_SYSTEMD_DIR/$unit.StartLimitIntervalUSec"
  printf '10'          > "$STUB_SYSTEMD_DIR/$unit.StartLimitBurst"
  : > "$STUB_SYSTEMD_DIR/$unit.DropInPaths"
}

drop_rig() { [ -n "${RIG:-}" ] && rm -rf "$RIG"; }

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
  [ "$WEB_SHOULD_FAIL" = "1" ] && return 1
  return 0
}

PREFLIGHT_SHOULD_FAIL=0
preflight_body() { [ "$PREFLIGHT_SHOULD_FAIL" = "1" ] && return 1; return 0; }

RESTART_SHOULD_FAIL=0
restart_body() { [ "$RESTART_SHOULD_FAIL" = "1" ] && return 1; return 0; }

VERIFY_SHOULD_FAIL=0
verify_body() { [ "$VERIFY_SHOULD_FAIL" = "1" ] && return 1; return 0; }

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
  local sha="$1"
  BUILD_SHA="$sha"
  # shellcheck disable=SC2086
  atomic_deploy "$sha" "refs/test" build_body "$RIG/env" preflight_body \
    restart_body verify_body $UNITS
}

reset_failures() {
  BUILD_SHOULD_FAIL=0; WEB_SHOULD_FAIL=0; PREFLIGHT_SHOULD_FAIL=0
  RESTART_SHOULD_FAIL=0; VERIFY_SHOULD_FAIL=0
}

# shellcheck source=../lib/atomic-release.sh
. "$LIB/atomic-release.sh"

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
# shellcheck disable=SC2086
atomic_deploy "$B" refs/test observing_prepare "$RIG/env" preflight_body \
  restart_body verify_body $UNITS >/dev/null 2>&1
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
VERIFY_SHOULD_FAIL=1
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
release_rollback "$ATOMIC_RELEASES" "$A" "$ATOMIC_CURRENT" >/dev/null 2>&1
check "explicit rollback returns to A" "$(simulate_restart)" "$A"
check "and returns the web assets too" "$(simulate_web_request)" "bundle-$A"
if release_rollback "$ATOMIC_RELEASES" "$C" "$ATOMIC_CURRENT" >/dev/null 2>&1; then
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
    [ -e "$ATOMIC_CURRENT/BUILT_SHA" ] || echo miss
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
release_rollback "$ATOMIC_RELEASES" "$A" "$ATOMIC_CURRENT" >/dev/null 2>&1
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
  done > "$RIG/split" ) &
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
release_rollback "$ATOMIC_RELEASES" "$A" "$ATOMIC_CURRENT" >/dev/null 2>&1
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

# ============================================================ report

echo ""
echo "-------------------------------------------------------------"
printf 'passed %s   failed %s\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'failing cases:%s\n' "$FAILED_CASES"
  exit 1
fi
exit 0
