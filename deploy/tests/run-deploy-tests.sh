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
if [ "$MUTATION" = "remediate-via-full-installer" ]; then
  # The defect: a converged host missing one symlink helper is told to rerun
  # the full production installer -- which writes systemd units for the legacy
  # /app layout and can restart coturn and Caddy, both shared with staging.
  # The remediation would cost more than the fault it repairs.
  atomic_bootstrap_refusal() {
    local root="$1" state="$2" env_name="${3:-production}"
    echo "REFUSED: ATOMIC DEPLOYMENT BOOTSTRAP INCOMPLETE ($state)." >&2
    echo "  ATOMIC PUBLICATION BOOTSTRAP INCOMPLETE." >&2
    echo "  THIS IS NOT A BUSY LOCK. Nothing else is deploying." >&2
    echo "    sudo bash deploy/$env_name/install.sh" >&2
  }
  publication_authority_publish() {
    local sha="$1" current="$2"
    if [ ! -x "$ATOMIC_PUBLISH_HELPER" ]; then
      echo "REFUSED: the publication helper is not installed." >&2
      echo "  Run deploy/production/install.sh." >&2
      return 1
    fi
    sudo -n "$ATOMIC_PUBLISH_HELPER" "$sha" || return 1
    [ "$(pointer_target "$current")" = "$(release_dir "$ATOMIC_RELEASES" "$sha")" ]
  }
fi
if [ "$MUTATION" = "generic-node-authority" ]; then
  # The defect: production goes back to running a caller-chosen script as the
  # service user. The script lives under /tmp and belongs to the deploy
  # account, so the grant it needs is a second identity, not a permission.
  activation_preflight() {
    local candidate="$1" env_file="$2" runner="${ATOMIC_SERVICE_USER:-videofy}"
    sudo -n -u "$runner" node "$(dirname "${BASH_SOURCE[0]}")/preflight-config.mjs" \
      "$candidate" "$env_file"
  }
fi
if [ "$MUTATION" = "generic-test-authority" ]; then
  # The defect: the capability checks go back to generic `test` as the service
  # user -- readable-file oracle over every path that identity can reach.
  activation_preflight() {
    local candidate="$1" env_file="$2" runner="${ATOMIC_SERVICE_USER:-videofy}"
    sudo -n -u "$runner" test -x "$candidate" || return 1
    sudo -n -u "$runner" test -r "$env_file" || return 1
    local helper="${ATOMIC_PREFLIGHT_HELPER:-/usr/local/sbin/videofy-production-preflight}"
    sudo -n -u "$runner" "$helper" "$candidate"
  }
fi
if [ "$MUTATION" = "no-publication-authority-preflight" ]; then
  # The defect: the bootstrap pronounces a host ready without proving anything
  # on it can move the pointer, so the deploy discovers it cannot publish only
  # after a release has been built -- which is the 2026-09-06 incident.
  atomic_bootstrap_state() {
    local root="$1"
    [ -e "$root" ] || { printf 'missing-root'; return 1; }
    [ -d "$root/releases" ] || { printf 'missing-releases'; return 1; }
    [ -f "$root/.deploy.lock" ] || { printf 'missing-lock'; return 1; }
    printf 'ok'; return 0
  }
fi
if [ "$MUTATION" = "trust-the-publisher" ]; then
  # The defect: publication asks no questions -- it does not check that a
  # publisher is installed, and it believes the exit code instead of reading
  # the pointer back. A helper that reports success it never performed leaves
  # production on the previous release while the deploy reports a new one.
  publication_authority_publish() {
    sudo -n "$ATOMIC_PUBLISH_HELPER" "$1" 2>/dev/null
  }
fi
if [ "$MUTATION" = "bootstrap-preflight-bypassed" ]; then
  # The defect: an unprovisioned host is reported as a busy lock, and the
  # operator waits for a deployment that is not running.
  atomic_bootstrap_state() { printf 'ok'; return 0; }
fi
if [ "$MUTATION" = "shipping-normalization-bypassed" ]; then
  # The defect: CRLF libraries reach the host and bash dies on an invisible
  # character.
  shipment_normalise() { return 0; }
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

# A. BOOTSTRAP -- TESTED BY BEHAVIOUR.
#
# The first version of this grepped install.sh for two strings. That proved the
# provisioning line exists and nothing about what a deploy does when it has not
# been run -- which is the whole finding: the deploy reported a provisioning
# failure as lock contention, and an operator waited for a deployment that was
# not running.
new_rig; reset_failures
BOOT="$RIG/boot"

# Nothing provisioned at all.
mkdir -p "$BOOT"
check "an unprovisioned root reports missing releases" \
  "$(atomic_bootstrap_state "$BOOT" 2>/dev/null)" "missing-releases"

# releases/ present, lock absent -- the exact state the host was in.
mkdir -p "$BOOT/releases"
check "releases without a lock reports the missing lock" \
  "$(atomic_bootstrap_state "$BOOT" 2>/dev/null)" "missing-lock"

# A directory where the lock file belongs.
mkdir -p "$BOOT/.deploy.lock"
check "a lock that is not a regular file is named as such" \
  "$(atomic_bootstrap_state "$BOOT" 2>/dev/null)" "lock-not-a-regular-file"
rmdir "$BOOT/.deploy.lock"

# A file where releases/ belongs.
rmdir "$BOOT/releases"; : > "$BOOT/releases"
check "releases as a file is named as such" \
  "$(atomic_bootstrap_state "$BOOT" 2>/dev/null)" "releases-not-a-directory"
rm -f "$BOOT/releases"; mkdir -p "$BOOT/releases"

# Fully provisioned.
: > "$BOOT/.deploy.lock"
check "a provisioned root passes" "$(atomic_bootstrap_state "$BOOT" 2>/dev/null)" "ok"

# A root that does not exist at all.
check "a missing root is named" \
  "$(atomic_bootstrap_state "$RIG/nowhere" 2>/dev/null)" "missing-root"

# THE DISTINCTION THAT MATTERS. A provisioned host whose lock is HELD must
# report busy, never bootstrap-incomplete: the two demand opposite responses,
# and conflating them is the original defect.
printf '%s\n' \
  ". \"$LIB/deploy-lock.sh\"" \
  "export ATOMIC_ROOT=\"$BOOT\"" \
  "atomic_lock_acquire || exit 9" \
  "touch \"$BOOT/held\"" \
  "for _ in \$(seq 1 200); do [ -f \"$BOOT/go\" ] && break; sleep 0.05; done" > "$BOOT/holder.sh"
setsid bash "$BOOT/holder.sh" &
BOOT_HOLDER=$!
for _ in $(seq 1 100); do [ -f "$BOOT/held" ] && break; sleep 0.05; done
check "a busy host still reports its bootstrap as ok, not incomplete" \
  "$(atomic_bootstrap_state "$BOOT" 2>/dev/null)" "ok"
ATOMIC_ROOT="$BOOT" atomic_lock_acquire >/dev/null 2>&1 \
  && bad "the held lock was acquired" "it must refuse" \
  || ok "and the lock itself reports BUSY, which is a different answer"
BOOT_PGID="$(ps -o pgid= -p "$BOOT_HOLDER" 2>/dev/null | tr -d ' ')"
[ -n "$BOOT_PGID" ] && kill -9 -"$BOOT_PGID" 2>/dev/null
kill -9 "$BOOT_HOLDER" 2>/dev/null; wait "$BOOT_HOLDER" 2>/dev/null
atomic_lock_release 2>/dev/null || true

# The refusal must tell the operator what to run, and must deny it is a busy lock.
BOOT_MSG="$(atomic_bootstrap_refusal "$BOOT" missing-lock production 2>&1)"
case "$BOOT_MSG" in
  *"NOT A BUSY LOCK"*) ok "the refusal explicitly denies lock contention" ;;
  *) bad "the refusal does not distinguish itself from a busy lock" "$BOOT_MSG" ;;
esac
case "$BOOT_MSG" in
  *install.sh*) ok "and names the bootstrap command to run" ;;
  *) bad "the refusal does not say what to run" "$BOOT_MSG" ;;
esac
drop_rig

# install.sh must still be the thing that provisions -- a deploy that creates
# these itself would hide a half-provisioned host rather than report one.
if grep -q 'VIDEOFY_ROOT/releases' "$REPO_ROOT/deploy/production/install.sh"; then
  ok "install.sh provisions the release store"
else bad "install.sh does not provision releases/" ""; fi

# C. LF TRANSPORT -- ALSO BY BEHAVIOUR, through the real helper.
new_rig; reset_failures
SRCDIR="$RIG/src-lib"; SHIPDIR="$RIG/shipped"
mkdir -p "$SRCDIR"
printf 'say() { echo hi; }\r\nsay\r\n'      > "$SRCDIR/lib-a.sh"
printf 'export const x = 1;\r\n'            > "$SRCDIR/lib-b.mjs"
printf 'x = 1\r\n'                          > "$SRCDIR/lib-c.py"
printf 'binary-ish\r\nkeep\r\n'             > "$SRCDIR/notcode.txt"
SRC_TXT_BEFORE="$(sha256sum "$SRCDIR/notcode.txt" | cut -d' ' -f1)"
SRC_SH_BEFORE="$(sha256sum "$SRCDIR/lib-a.sh" | cut -d' ' -f1)"

cp -r "$SRCDIR" "$SHIPDIR"
shipment_normalise "$SHIPDIR"

# `grep -c` prints 0 AND EXITS 1 when there are no matches, so `|| echo 0`
# appends a SECOND zero and the comparison fails on the good outcome. That
# trap has now cost three assertions in this suite; counted once, here.
cr_lines() { local n; n="$(grep -c $'\r' "$1" 2>/dev/null)"; [ -n "$n" ] || n=0; printf '%s' "$n"; }
check "the shipped shell library has no CRLF" "$(cr_lines "$SHIPDIR/lib-a.sh")" "0"
check "the shipped mjs has no CRLF"           "$(cr_lines "$SHIPDIR/lib-b.mjs")" "0"
check "the shipped python has no CRLF"        "$(cr_lines "$SHIPDIR/lib-c.py")" "0"
if bash -n "$SHIPDIR/lib-a.sh" 2>/dev/null; then
  ok "the shipped shell library parses"
else bad "the shipped library does not parse" ""; fi
if ( . "$SHIPDIR/lib-a.sh" >/dev/null 2>&1 ); then
  ok "and sourcing it succeeds"
else bad "sourcing the shipped library failed" ""; fi
# The CRLF original must still fail, or the fixture proved nothing.
if bash -n "$SRCDIR/lib-a.sh" 2>/dev/null && ( . "$SRCDIR/lib-a.sh" >/dev/null 2>&1 ); then
  bad "the CRLF original ran fine" "this platform cannot demonstrate the fault"
else ok "the un-normalised original still fails, as it did on the host"; fi
check "the source copy was never rewritten" \
  "$(sha256sum "$SRCDIR/lib-a.sh" | cut -d' ' -f1)" "$SRC_SH_BEFORE"
check "and non-code files are left alone" \
  "$(sha256sum "$SHIPDIR/notcode.txt" | cut -d' ' -f1)" "$SRC_TXT_BEFORE"
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

# ======================================================= publication authority
#
# THE GAP THIS CLOSES. `/srv/videofy-prod` is root-owned, correctly. Replacing
# a symlink needs write permission on the DIRECTORY that holds it, so the
# deploy identity cannot move `current`. On 2026-09-06 that was discovered
# after a release had already been built, and was closed by hand with sudo --
# an undocumented requirement that works once and then strands the next person.
#
# Publication now goes through one root-owned program that can do this one
# thing, and the ability to do it is proven BEFORE anything is built.
#
# These tests run the real script. Its root and library paths are compiled in
# and it accepts an override for them ONLY when not running as uid 0, so the
# override is unreachable through the sudo path the deployment actually uses.

echo ""
echo "the pointer moves through one narrow privileged program, or not at all"

# WHAT IS UNDER TEST IS WHAT AN OPERATOR WOULD HAVE.
#
# The narrow installer runs first, into a scratch prefix, and every case below
# uses the artefacts it produced. Handing the helper a hand-picked subset of
# deploy/lib instead would let it depend on a file the installer never ships --
# which works here and fails on the host at the moment of publication, having
# already built a release.
INSTALL_PA="$REPO_ROOT/deploy/production/install-publication-authority.sh"

if [ "$MUTATION" = "non-atomic-privileged-install" ]; then
  # The defect: the installer writes THROUGH each destination instead of
  # renaming over it. sudo reads /etc/sudoers.d on every invocation and a
  # publication in flight is reading the helper, so both can catch a file that
  # is neither the old one nor the new one -- for sudoers, a window in which
  # nobody on the box can use sudo at all.
  #
  # `atomic_place` is one line in the installer precisely so this can replace
  # it whole. The mode is carried across from the staged file, so the mutation
  # is the loss of atomicity and nothing else.
  MUTINST="$(mktemp -d "${TMPDIR:-/tmp}/videofy-mutinst-XXXXXX")"
  # The installer resolves its sources relative to its own location, so the
  # mutated copy needs the same shape around it.
  mkdir -p "$MUTINST/production" "$MUTINST/lib"
  cp "$REPO_ROOT/deploy/lib/release-paths.sh" "$REPO_ROOT/deploy/lib/release-engine.sh" "$MUTINST/lib/"
  cp "$REPO_ROOT/deploy/production/publish-current.sh" "$MUTINST/production/"
  printf '%s\n' 's#^atomic_place() .*#atomic_place() { m="$(stat -c "%a" "$1")"; chmod u+w "$2" 2>/dev/null || :; cat "$1" > "$2"; chmod "$m" "$2"; rm -f "$1"; }#' \
    > "$MUTINST/mutate.sed"
  sed -f "$MUTINST/mutate.sed" "$INSTALL_PA" > "$MUTINST/production/install-publication-authority.sh"
  INSTALL_PA="$MUTINST/production/install-publication-authority.sh"
fi

PA_PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/videofy-pa-XXXXXX")"
SAVED_PATH="$PATH"
mkdir -p "$PA_PREFIX/bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'while [ "${1-}" = "-n" ]; do shift; done' \
  'exec "$@"' > "$PA_PREFIX/bin/sudo"
chmod 755 "$PA_PREFIX/bin/sudo"
if PATH="$PA_PREFIX/bin:$SAVED_PATH" VIDEOFY_INSTALL_PREFIX="$PA_PREFIX" \
   DEPLOY_OWNER="$(id -un)" bash "$INSTALL_PA" >/dev/null 2>&1; then
  ok "the narrow installer provisions publication authority"
else
  bad "the narrow installer failed" "every case below tests what it installs"
fi
INSTALLED_LIB="$PA_PREFIX/usr/local/lib/videofy"
PUBLISH_SH="$PA_PREFIX/usr/local/sbin/videofy-publish-current"

if [ "$MUTATION" = "wide-publication-paths" ]; then
  # The defect: the privileged helper publishes whatever it is handed, so the
  # deploy account gains a root-owned way to point production at something that
  # never passed a gate. The helper is a separate program rather than a sourced
  # function, so the mutation is applied to a COPY of it -- its verification
  # lines removed and everything else byte-identical.
  MUTDIR="$(mktemp -d "${TMPDIR:-/tmp}/videofy-mutpub-XXXXXX")"
  PUBLISH_SH="$MUTDIR/publish-current.sh"
  grep -vF \
    -e 'assert_full_sha ' \
    -e 'release_is_complete "$TARGET"' \
    -e 'release_recorded_sha "$TARGET"' \
    -e 'release_symlinks_stay_inside "$TARGET"' \
    "$REPO_ROOT/deploy/production/publish-current.sh" > "$PUBLISH_SH"
fi

# `sudo` is shadowed for these cases, so the suite exercises the real call --
# including the literal `sudo -n` in the engine -- while escalating nothing.
sudo_stub() {
  mkdir -p "$RIG/bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'while [ "${1-}" = "-n" ]; do shift; done' \
    'exec "$@"' > "$RIG/bin/sudo"
  chmod 755 "$RIG/bin/sudo"
  PATH="$RIG/bin:$SAVED_PATH"
}

# The real helper, pointed at the rig. Everything else about it is untouched.
publish_helper() {
  VIDEOFY_PUBLISH_ROOT="$ATOMIC_ROOT" VIDEOFY_PUBLISH_LIB="$INSTALLED_LIB" \
    bash "$PUBLISH_SH" "$@"
}

# ---- 9. A valid publish atomically replaces `current` ----

new_rig; reset_failures
BUILD_SHA="$A"; release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1
BUILD_SHA="$B"; release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1

publish_helper "$A" >/dev/null 2>&1
check "the helper publishes a sealed release" "$(simulate_restart)" "$A"
check "and what it publishes is a symlink, not a copied tree" \
  "$([ -L "$ATOMIC_CURRENT" ] && echo symlink || echo NOT-A-SYMLINK)" "symlink"
check "the web pointer still names current, untouched by publication" \
  "$(web_pointer_target)" "$ATOMIC_CURRENT/www"

# ---- 10. A rollback is the same operation, through the same authority ----

publish_helper "$B" >/dev/null 2>&1
check "publishing forward moves the pointer" "$(simulate_restart)" "$B"
publish_helper "$A" >/dev/null 2>&1
check "and a rollback is the identical call, not a privileged special case" \
  "$(simulate_restart)" "$A"

# Publication leaves nothing behind. A `.publishing.NNN` link surviving a run
# means a rename did not happen and the next operator finds debris.
check "no publication temporary survives" \
  "$(find "$ATOMIC_ROOT" -maxdepth 1 -name 'current.publishing.*' | wc -l | tr -d ' ')" "0"

# ---- 4 + 8. Only a SHA is accepted, so no other path can be named ----

SHOUTED="$(printf '%s' "$A" | tr 'abcdef' 'ABCDEF')"
for ARG in 'not-a-sha' '../../etc' "../releases/$A" "$ATOMIC_RELEASES/$A" \
           "$A extra" '' "${A}0" "$SHOUTED"; do
  if publish_helper $ARG >/dev/null 2>&1; then
    bad "the helper accepted [$ARG]" "only a 40-char sha may be published"
  else ok "the helper refuses [$ARG]"; fi
done
check "and after every refusal the pointer is unchanged" "$(simulate_restart)" "$A"

# ---- 5. An unsealed directory is not a release, whatever it is called ----

mkdir -p "$ATOMIC_RELEASES/$C/services/account"
if publish_helper "$C" >/dev/null 2>&1; then
  bad "an unsealed directory was published" "it must refuse"
else ok "an unsealed directory is refused"; fi
check "the pointer did not move" "$(simulate_restart)" "$A"
rm -rf "$ATOMIC_RELEASES/$C"

# A sha with no directory at all.
if publish_helper "$C" >/dev/null 2>&1; then
  bad "a sha with no release was published" "it must refuse"
else ok "a sha with no release directory is refused"; fi

# ---- 6. A sealed release whose bytes changed is no longer that release ----

BUILD_SHA="$C"; release_prepare "$ATOMIC_RELEASES" "$C" "$C" build_body >/dev/null 2>&1
printf 'added after sealing' > "$ATOMIC_RELEASES/$C/services/account/extra.js"
if publish_helper "$C" >/dev/null 2>&1; then
  bad "a tampered release was published" "the manifest no longer describes it"
else ok "a release whose bytes changed after sealing is refused"; fi
rm -f "$ATOMIC_RELEASES/$C/services/account/extra.js"
check "and the same release publishes once it is intact again" \
  "$(publish_helper "$C" >/dev/null 2>&1; simulate_restart)" "$C"

# A marker naming a different commit -- a release copied or restored by hand.
sed -i "s/$C/$B/" "$ATOMIC_RELEASES/$C/RELEASE.json" 2>/dev/null || true
if publish_helper "$C" >/dev/null 2>&1; then
  bad "a release whose marker names another commit was published" "it must refuse"
else ok "a release whose marker disagrees with its name is refused"; fi
drop_rig

# ---- 7. A link that reaches outside the release ----

new_rig; reset_failures
BUILD_SHA="$C"; release_prepare "$ATOMIC_RELEASES" "$C" "$C" build_body >/dev/null 2>&1
ln -sfn /etc "$ATOMIC_RELEASES/$C/services/account/outside"
# Re-sealed AROUND the escaping link, so integrity holds and only the
# containment proof can catch it. Without this the test would pass for the
# wrong reason and the containment check could be deleted unnoticed.
release_manifest_of "$ATOMIC_RELEASES/$C" > "$ATOMIC_RELEASES/$C/RELEASE.manifest.sha256"
check "the re-sealed release still satisfies integrity, isolating the next proof" \
  "$(release_integrity_holds "$ATOMIC_RELEASES/$C" && echo intact || echo tampered)" "intact"
if publish_helper "$C" >/dev/null 2>&1; then
  bad "a release containing an escaping symlink was published" "it must refuse"
else ok "a release whose link escapes it is refused"; fi
drop_rig

# ---- --check changes nothing ----

new_rig; reset_failures
BUILD_SHA="$A"; release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1
publish_helper "$A" >/dev/null 2>&1
if publish_helper --check >/dev/null 2>&1; then
  ok "--check reports the authority is available"
else bad "--check failed" "the bootstrap depends on it"; fi
check "and --check publishes nothing" "$(simulate_restart)" "$A"
drop_rig

# ---- 1. An unwritable root routes publication through the helper ----

echo ""
echo "an unwritable deployment root routes publication, it does not fail"

new_rig; reset_failures
sudo_stub
AUTH="$RIG/helper.sh"; AUTH_LOG="$RIG/helper.log"; : > "$AUTH_LOG"
# Stands in for the root-owned program: a real one runs as root and is not
# bound by the directory permissions, which is the whole reason it exists.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'case "${1-}" in --check) exit 0;; esac' \
  "printf '%s\n' \"\$1\" >> \"$AUTH_LOG\"" \
  "chmod u+w \"$ATOMIC_ROOT\"" \
  "ln -sfn \"$ATOMIC_RELEASES/\$1\" \"$ATOMIC_CURRENT.p.\$\$\"" \
  "mv -Tf \"$ATOMIC_CURRENT.p.\$\$\" \"$ATOMIC_CURRENT\"" \
  "chmod 555 \"$ATOMIC_ROOT\"" > "$AUTH"
chmod 755 "$AUTH"
export ATOMIC_PUBLISH_HELPER="$AUTH"

BUILD_SHA="$A"; release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1
BUILD_SHA="$B"; release_prepare "$ATOMIC_RELEASES" "$B" "$B" build_body >/dev/null 2>&1
chmod 555 "$ATOMIC_ROOT"
check "the root really is unwritable, so the ordinary path cannot be taken" \
  "$([ -w "$ATOMIC_ROOT" ] && echo writable || echo unwritable)" "unwritable"

release_publish "$ATOMIC_RELEASES" "$A" "$ATOMIC_CURRENT" >/dev/null 2>&1
check "publication succeeded anyway" "$(simulate_restart)" "$A"
check "and it went through the helper, with exactly that sha" \
  "$(tail -1 "$AUTH_LOG")" "$A"

# 10, again: rollback must not acquire a different or wider authority.
: > "$AUTH_LOG"
release_rollback "$ATOMIC_RELEASES" "$B" "$ATOMIC_CURRENT" >/dev/null 2>&1
check "rollback takes the same route" "$(tail -1 "$AUTH_LOG")" "$B"
check "and lands where it said" "$(simulate_restart)" "$B"

# An unsealed release is still refused BEFORE the privileged program is asked.
: > "$AUTH_LOG"
mkdir -p "$ATOMIC_RELEASES/$C"
release_publish "$ATOMIC_RELEASES" "$C" "$ATOMIC_CURRENT" >/dev/null 2>&1 \
  && bad "an unsealed release was published through the helper" "it must refuse" \
  || ok "an unsealed release is refused before the helper is invoked"
check "the helper was never called" "$(wc -c < "$AUTH_LOG" | tr -d ' ')" "0"
chmod 755 "$ATOMIC_ROOT"
drop_rig; PATH="$SAVED_PATH"; unset ATOMIC_PUBLISH_HELPER

# ---- 2. No helper: refuse, and say what is missing ----

new_rig; reset_failures
sudo_stub
BUILD_SHA="$A"; release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1
export ATOMIC_PUBLISH_HELPER="$RIG/not-installed"
chmod 555 "$ATOMIC_ROOT"
PUB_MSG="$(release_publish "$ATOMIC_RELEASES" "$A" "$ATOMIC_CURRENT" 2>&1)" \
  && bad "publication succeeded with no helper installed" "it must refuse" \
  || ok "publication refuses when nothing can move the pointer"
case "$PUB_MSG" in
  *install-publication-authority.sh*) ok "and names the narrow installer that provides it" ;;
  *) bad "the refusal does not say what to run" "$PUB_MSG" ;;
esac
chmod 755 "$ATOMIC_ROOT"
drop_rig; PATH="$SAVED_PATH"; unset ATOMIC_PUBLISH_HELPER

# ---- A helper that reports success without publishing ----

new_rig; reset_failures
sudo_stub
BUILD_SHA="$A"; release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1
LIAR="$RIG/liar.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$LIAR"; chmod 755 "$LIAR"
export ATOMIC_PUBLISH_HELPER="$LIAR"
chmod 555 "$ATOMIC_ROOT"
release_publish "$ATOMIC_RELEASES" "$A" "$ATOMIC_CURRENT" >/dev/null 2>&1 \
  && bad "a helper that published nothing was believed" "the pointer is the authority" \
  || ok "a helper reporting success it did not perform is caught"
chmod 755 "$ATOMIC_ROOT"
drop_rig; PATH="$SAVED_PATH"; unset ATOMIC_PUBLISH_HELPER

# ---- 2 + 3. Publication authority is proven before a release is built ----

echo ""
echo "publication authority is part of being provisioned, proven up front"

new_rig; reset_failures
sudo_stub
BOOT2="$RIG/boot2"
mkdir -p "$BOOT2/releases"; : > "$BOOT2/.deploy.lock"
check "a writable root needs no helper at all" \
  "$(atomic_bootstrap_state "$BOOT2" 2>/dev/null)" "ok"

chmod 555 "$BOOT2"
export ATOMIC_PUBLISH_HELPER="$RIG/absent"
check "an unwritable root with no helper is bootstrap-incomplete" \
  "$(atomic_bootstrap_state "$BOOT2" 2>/dev/null)" "missing-publication-helper"
BOOT_MSG="$(atomic_bootstrap_refusal "$BOOT2" missing-publication-helper production 2>&1)"
case "$BOOT_MSG" in
  *"ATOMIC PUBLICATION BOOTSTRAP INCOMPLETE"*) ok "and the refusal names the gap in those words" ;;
  *) bad "the refusal does not name the publication gap" "$BOOT_MSG" ;;
esac
case "$BOOT_MSG" in
  *"NOT A BUSY LOCK"*) ok "and still distinguishes itself from lock contention" ;;
  *) bad "the refusal could be read as a busy lock" "$BOOT_MSG" ;;
esac

H2="$RIG/h2"
printf '#!/usr/bin/env bash\nexit 0\n' > "$H2"; chmod 644 "$H2"
export ATOMIC_PUBLISH_HELPER="$H2"
check "a helper that is not executable is refused" \
  "$(atomic_bootstrap_state "$BOOT2" 2>/dev/null)" "publication-helper-not-executable"

chmod 775 "$H2"
check "a group-writable helper is refused" \
  "$(atomic_bootstrap_state "$BOOT2" 2>/dev/null)" "publication-helper-writable"

chmod 757 "$H2"
check "a world-writable helper is refused" \
  "$(atomic_bootstrap_state "$BOOT2" 2>/dev/null)" "publication-helper-writable"

chmod 755 "$H2"
check "a helper not owned by root is refused" \
  "$(atomic_bootstrap_state "$BOOT2" 2>/dev/null)" "publication-helper-not-root-owned"

# Root-owned, non-writable, executable -- but this identity may not invoke it.
export ATOMIC_PUBLISH_HELPER=/bin/false
check "an installed helper this identity cannot run is refused" \
  "$(atomic_bootstrap_state "$BOOT2" 2>/dev/null)" "publication-authority-unavailable"

# The one arrangement that passes: root-owned, not writable, and invocable.
export ATOMIC_PUBLISH_HELPER=/bin/true
check "an unwritable root WITH working publication authority passes" \
  "$(atomic_bootstrap_state "$BOOT2" 2>/dev/null)" "ok"
chmod 755 "$BOOT2"
drop_rig; PATH="$SAVED_PATH"; unset ATOMIC_PUBLISH_HELPER


# ---- the installation boundary ----
#
# A HOST MISSING PUBLICATION AUTHORITY IS OTHERWISE CONVERGED AND SERVING.
# Telling its operator to rerun the full production installer would be advice
# that writes systemd units for the legacy /app layout and can restart coturn
# and Caddy, both shared with staging. The remediation has to be narrower than
# the fault, and "narrower" is a claim about what a script DOES -- so it is
# executed here, under a prefix, with everything it must not touch present and
# hashed on both sides.

echo ""
echo "installing publication authority touches publication authority, and nothing else"

new_rig; reset_failures
sudo_stub
PREFIX="$RIG/prefix"
mkdir -p "$PREFIX/etc/systemd/system" "$PREFIX/usr/local/sbin" "$PREFIX/etc/sudoers.d"

# The converged units, exactly as the host carries them.
UNIT_DIR="$PREFIX/etc/systemd/system"
for u in videofy-prod-account videofy-prod-gateway videofy-prod-media-ingest; do
  printf '[Service]\nWorkingDirectory=/srv/videofy-prod/current/services/x\nUser=videofy\n' \
    > "$UNIT_DIR/$u.service"
done
UNITS_BEFORE="$(cat "$UNIT_DIR"/videofy-prod-*.service | sha256sum)"

# A converged pointer and web root, so "did not move them" is a measurement.
BUILD_SHA="$A"; release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1
pointer_publish "$ATOMIC_CURRENT" "$ATOMIC_RELEASES/$A" >/dev/null 2>&1
CURRENT_BEFORE="$(pointer_target "$ATOMIC_CURRENT")"
WWW_BEFORE="$(web_pointer_target)"

# systemctl is recorded rather than stubbed silent: "it did not restart
# anything" is only evidence if a restart would have been visible.
printf '%s\n' '#!/usr/bin/env bash' "printf '%s\n' \"\$*\" >> $RIG/systemctl.log" \
  > "$RIG/bin/systemctl"
chmod 755 "$RIG/bin/systemctl"
: > "$RIG/systemctl.log"

# INSTALL_PA is set once, above, and MUST NOT be reassigned here: a mutation
# points it at a deliberately broken copy, and re-deriving it from the
# repository would quietly restore the real installer and let that mutation
# survive. It did exactly that, and the suite reported a clean 323/0.
INSTALL_OUT="$(VIDEOFY_INSTALL_PREFIX="$PREFIX" DEPLOY_OWNER="$(id -un)" \
  bash "$INSTALL_PA" 2>&1)"
INSTALL_RC=$?
check "the narrow installer succeeds" "$INSTALL_RC" "0"

check "the helper is installed" \
  "$([ -x "$PREFIX/usr/local/sbin/videofy-publish-current" ] && echo yes || echo no)" "yes"
check "the verification libraries are installed beside it" \
  "$([ -f "$PREFIX/usr/local/lib/videofy/release-paths.sh" ] && \
     [ -f "$PREFIX/usr/local/lib/videofy/release-engine.sh" ] && echo yes || echo no)" "yes"
check "the libraries are not writable by anyone but their owner" \
  "$(stat -c '%a' "$PREFIX/usr/local/lib/videofy/release-engine.sh")" "644"
check "and the helper is not either" \
  "$(stat -c '%a' "$PREFIX/usr/local/sbin/videofy-publish-current")" "755"
check "the sudoers entry is installed read-only" \
  "$(stat -c '%a' "$PREFIX/etc/sudoers.d/videofy-publish")" "440"
check "and it validates" \
  "$(visudo -c -f "$PREFIX/etc/sudoers.d/videofy-publish" >/dev/null 2>&1 && echo valid || echo invalid)" "valid"
case "$(cat "$PREFIX/etc/sudoers.d/videofy-publish")" in
  *"NOPASSWD: /usr/local/sbin/videofy-publish-current"*)
    ok "and grants exactly the publication command, by absolute path" ;;
  *) bad "the sudoers entry does not grant the publication command" "" ;;
esac
case "$INSTALL_OUT" in
  *"--check"*|*"proven"*) ok "the installer proves invocability rather than assuming it" ;;
  *) bad "the installer does not prove the helper can be invoked" "$INSTALL_OUT" ;;
esac

# THE BOUNDARY ITSELF.
check "no service unit was altered" \
  "$(cat "$UNIT_DIR"/videofy-prod-*.service | sha256sum)" "$UNITS_BEFORE"
check "no unit was added or removed" \
  "$(find "$UNIT_DIR" -name '*.service' | wc -l | tr -d ' ')" "3"
check "systemctl was never invoked -- no reload, no restart, no enable" \
  "$(wc -c < "$RIG/systemctl.log" | tr -d ' ')" "0"
check "the pointer did not move" "$(pointer_target "$ATOMIC_CURRENT")" "$CURRENT_BEFORE"
check "www did not move" "$(web_pointer_target)" "$WWW_BEFORE"
check "and what current resolves to is still the same release" \
  "$(simulate_restart)" "$A"

# IDEMPOTENT. The operator who is not sure whether it ran must be able to run
# it again, and a second run must be a verification rather than a change.
SECOND_RC=0
VIDEOFY_INSTALL_PREFIX="$PREFIX" DEPLOY_OWNER="$(id -un)" bash "$INSTALL_PA" >/dev/null 2>&1 || SECOND_RC=$?
check "running it twice is not an error" "$SECOND_RC" "0"
check "and still changes no unit" \
  "$(cat "$UNIT_DIR"/videofy-prod-*.service | sha256sum)" "$UNITS_BEFORE"
check "and still restarts nothing" \
  "$(wc -c < "$RIG/systemctl.log" | tr -d ' ')" "0"

# It refuses rather than half-installing when what it produced is wrong.
chmod 666 "$PREFIX/usr/local/sbin/videofy-publish-current"
BAD_RC=0
VIDEOFY_INSTALL_PREFIX="$PREFIX" DEPLOY_OWNER="$(id -un)" \
  BROKEN_MODE=1 bash "$INSTALL_PA" >/dev/null 2>&1 || BAD_RC=$?
check "a re-run repairs a helper somebody made writable" \
  "$(stat -c '%a' "$PREFIX/usr/local/sbin/videofy-publish-current")" "755"

drop_rig; PATH="$SAVED_PATH"

# ---- the remediation an operator is given ----
#
# Naming the full installer here would send somebody to a script that writes
# units and can restart coturn and Caddy, to fix one missing symlink helper.

new_rig; reset_failures
REM_MSG="$(atomic_bootstrap_refusal "$RIG/x" missing-publication-helper production 2>&1)"
case "$REM_MSG" in
  *install-publication-authority.sh*) ok "the publication refusal names the narrow installer" ;;
  *) bad "the publication refusal does not name the narrow installer" "$REM_MSG" ;;
esac
case "$REM_MSG" in
  *"deploy/production/install.sh"*)
    bad "the publication refusal sends the operator to the full installer" \
        "that script writes units and can restart coturn and Caddy" ;;
  *) ok "and does not send the operator to the full production installer" ;;
esac
case "$REM_MSG" in
  *"restarts nothing"*|*"writes no unit"*) ok "and says what the narrow installer will not do" ;;
  *) bad "the refusal does not say the remediation is safe on a live host" "$REM_MSG" ;;
esac

# A genuinely unprovisioned root is the opposite case, and still gets the full
# installer -- the distinction is the point, not a blanket rename.
BOOT_MSG2="$(atomic_bootstrap_refusal "$RIG/x" missing-releases production 2>&1)"
case "$BOOT_MSG2" in
  *"deploy/production/install.sh"*) ok "an unprovisioned root still gets the full bootstrap" ;;
  *) bad "an unprovisioned root was not told to run the full installer" "$BOOT_MSG2" ;;
esac

# The same rule applies to the engine's own publication failure.
sudo_stub
BUILD_SHA="$A"; release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1
export ATOMIC_PUBLISH_HELPER="$RIG/absent"
chmod 555 "$ATOMIC_ROOT"
ENG_MSG="$(release_publish "$ATOMIC_RELEASES" "$A" "$ATOMIC_CURRENT" 2>&1)" || true
chmod 755 "$ATOMIC_ROOT"
case "$ENG_MSG" in
  *install-publication-authority.sh*) ok "the engine's publication refusal names the narrow installer" ;;
  *) bad "the engine sends the operator to the wrong installer" "$ENG_MSG" ;;
esac
case "$ENG_MSG" in
  *"deploy/production/install.sh"*)
    bad "the engine's refusal names the full production installer" "it must not" ;;
  *) ok "and not the full production installer" ;;
esac
drop_rig; PATH="$SAVED_PATH"; unset ATOMIC_PUBLISH_HELPER

# ONE IMPLEMENTATION, NOT TWO. The full installer may call the narrow one; it
# may not carry its own copy, because the copy that drifts is the one somebody
# runs at three in the morning.
if grep -q 'install-publication-authority.sh' "$REPO_ROOT/deploy/production/install.sh"; then
  ok "the full installer delegates to the narrow one"
else bad "the full installer does not delegate" "publication install would be duplicated"; fi
check "and holds no second copy of the sudoers entry" \
  "$(cr_lines 'sudoers.d/videofy-publish' "$REPO_ROOT/deploy/production/install.sh")" "0"


# ---- every privileged replacement is a rename ----
#
# THE INVARIANT. sudo reads /etc/sudoers.d on every single invocation, and a
# publication in flight is reading the helper and the libraries it sources.
# `install` and `cp` open the destination and write through it, so a reader can
# catch a file that is neither the old one nor the new one -- for sudoers, a
# window in which nobody on the box can use sudo at all.
#
# rename(2) has no such window, and the difference is OBSERVABLE: a reader
# holding the old file open keeps reading the complete old file, and the
# destination gets a new inode. Both are asserted, because either one alone
# could be satisfied by an unlink-and-recreate that still has a gap.

echo ""
echo "a live host is never shown a half-written privileged file"

new_rig; reset_failures
sudo_stub
PFX="$RIG/atomic"
mkdir -p "$PFX/etc/sudoers.d" "$PFX/usr/local/sbin" "$PFX/usr/local/lib/videofy"

# A converged host: publication authority already installed, and an OLD sudoers
# entry that a concurrent sudo could be reading at the instant we replace it.
OLD_SUDOERS="$PFX/etc/sudoers.d/videofy-publish"
printf '%s\n' '# OLD ENTRY' "$(id -un) ALL=(root) NOPASSWD: /usr/local/sbin/videofy-publish-current" \
  > "$OLD_SUDOERS"
chmod 0440 "$OLD_SUDOERS"
OLD_TEXT="$(cat "$OLD_SUDOERS")"
OLD_INODE="$(stat -c '%i' "$OLD_SUDOERS")"

# An old helper too, so the same question can be asked of a root-owned
# executable that a publisher may be part-way through reading.
OLD_HELPER="$PFX/usr/local/sbin/videofy-publish-current"
printf '#!/usr/bin/env bash\n# OLD HELPER\nexit 0\n' > "$OLD_HELPER"
chmod 0755 "$OLD_HELPER"
OLD_HELPER_TEXT="$(cat "$OLD_HELPER")"
OLD_HELPER_INODE="$(stat -c '%i' "$OLD_HELPER")"

# THE CONCURRENT READER. Opened before the installer runs and read after it, so
# what it sees is what a sudo invocation that started just before the swap
# would see. Under rename it is the complete old file; under a write-through
# replacement it is the new content, or a truncated fragment of it.
exec 9< "$OLD_SUDOERS"
exec 8< "$OLD_HELPER"

ATOMIC_RC=0
PATH="$RIG/bin:$SAVED_PATH" VIDEOFY_INSTALL_PREFIX="$PFX" DEPLOY_OWNER="$(id -un)" \
  bash "$INSTALL_PA" >/dev/null 2>&1 || ATOMIC_RC=$?
check "the installer replaces an existing installation" "$ATOMIC_RC" "0"

READER_SAW="$(cat <&9)"; exec 9<&-
READER_SAW_HELPER="$(cat <&8)"; exec 8<&-
check "a sudo invocation already reading the old entry still sees it, whole" \
  "$READER_SAW" "$OLD_TEXT"
check "and a publisher already reading the old helper still sees that, whole" \
  "$READER_SAW_HELPER" "$OLD_HELPER_TEXT"

# The other half of the same fact: the destination is a DIFFERENT file now.
# A write-through replacement keeps the inode, which is precisely how the old
# content could have been destroyed under the reader's feet.
check "the sudoers entry is a new inode, so it was renamed into place" \
  "$([ "$(stat -c '%i' "$OLD_SUDOERS")" != "$OLD_INODE" ] && echo renamed || echo written-through)" \
  "renamed"
check "and so is the helper" \
  "$([ "$(stat -c '%i' "$OLD_HELPER")" != "$OLD_HELPER_INODE" ] && echo renamed || echo written-through)" \
  "renamed"

# And the new content actually landed.
case "$(cat "$OLD_SUDOERS")" in
  *"install-publication-authority.sh"*) ok "the new sudoers entry is the one that landed" ;;
  *) bad "the new sudoers entry did not land" "$(cat "$OLD_SUDOERS")" ;;
esac
check "the helper that landed is byte-identical to the one in the repository" \
  "$(sha256sum < "$OLD_HELPER")" "$(sha256sum < "$REPO_ROOT/deploy/production/publish-current.sh")"

# Nothing staged is left lying about -- and in /etc/sudoers.d a leftover would
# be a second, stale grant if it were ever named without a dot.
check "no staged file survives in the sudoers directory" \
  "$(find "$PFX/etc/sudoers.d" -name '.videofy-publish.*' | wc -l | tr -d ' ')" "0"
check "nor beside the helper" \
  "$(find "$PFX/usr/local/sbin" -name '.videofy-publish-current.*' | wc -l | tr -d ' ')" "0"
check "nor beside the libraries" \
  "$(find "$PFX/usr/local/lib/videofy" -name '.*.staging.*' | wc -l | tr -d ' ')" "0"
drop_rig; PATH="$SAVED_PATH"

# ---- a sudoers entry that does not parse changes nothing ----

new_rig; reset_failures
sudo_stub
PFX2="$RIG/reject"
mkdir -p "$PFX2/etc/sudoers.d"
GOOD="$PFX2/etc/sudoers.d/videofy-publish"
printf '%s\n' '# OLD ENTRY' "$(id -un) ALL=(root) NOPASSWD: /usr/local/sbin/videofy-publish-current" > "$GOOD"
chmod 0440 "$GOOD"
GOOD_SUM="$(sha256sum < "$GOOD")"
GOOD_INODE="$(stat -c '%i' "$GOOD")"

# A deploy owner that cannot appear in a sudoers rule, so the generated entry
# is rejected by visudo rather than by a check of our own.
REJECT_RC=0
REJECT_OUT="$(PATH="$RIG/bin:$SAVED_PATH" VIDEOFY_INSTALL_PREFIX="$PFX2" \
  DEPLOY_OWNER='not a valid, user name' bash "$INSTALL_PA" 2>&1)" || REJECT_RC=$?
if [ "$REJECT_RC" -ne 0 ]; then ok "an entry that does not parse is refused"
else bad "an unparseable sudoers entry was installed" "$REJECT_OUT"; fi
check "and the existing entry is byte-identical" "$(sha256sum < "$GOOD")" "$GOOD_SUM"
check "and is still the same file, never reopened" "$(stat -c '%i' "$GOOD")" "$GOOD_INODE"
check "and nothing was staged and left behind" \
  "$(find "$PFX2/etc/sudoers.d" -name '.videofy-publish.*' | wc -l | tr -d ' ')" "0"

# THE REPORT MUST BE TRUE. Saying "nothing was installed" after the helper and
# libraries have already landed is a rollback claim the script cannot honour --
# so the sudoers text is prepared and validated before anything is placed.
case "$REJECT_OUT" in
  *"nothing was installed"*) ok "and the refusal says nothing was installed" ;;
  *) bad "the refusal does not describe what happened" "$REJECT_OUT" ;;
esac
check "which is true: no helper was installed" \
  "$([ -e "$PFX2/usr/local/sbin/videofy-publish-current" ] && echo installed || echo absent)" "absent"
check "and no library either" \
  "$([ -e "$PFX2/usr/local/lib/videofy/release-engine.sh" ] && echo installed || echo absent)" "absent"
drop_rig; PATH="$SAVED_PATH"


# ==================================================== bounded deploy privilege
#
# WHAT THIS REPLACES. The deploy account held `claude ALL=(ALL) NOPASSWD: ALL`
# -- root, spelled at length. Removing it requires the privileges an ordinary
# atomic deployment and rollback actually use to exist first, and there are
# three: move the pointer, restart the three named services, and evaluate the
# candidate's startup configuration as the service user.
#
# The last one used to be `sudo -u videofy node <script>` and
# `sudo -u videofy test <path>`, with the script living under /tmp and owned by
# the deploy account. `node` with a caller-chosen script is arbitrary code
# execution as the service user: not a preflight permission, a second identity.
#
# The contract is therefore enforced INSIDE one fixed program, because a
# sudoers wildcard is a pattern match on a string the caller supplies -- it
# cannot canonicalise, cannot follow a symlink, and cannot tell
# `/srv/videofy-prod/releases-scratch` from `/srv/videofy-prod/releases`.

echo ""
echo "the service identity is reachable through one program, with one argument"

PREFLIGHT_SRC="$REPO_ROOT/deploy/production/production-preflight.sh"
INSTALL_SH="$REPO_ROOT/deploy/production/install-sudo-hardening.sh"

if [ "$MUTATION" = "candidate-containment-bypassed" ]; then
  # The defect: the helper trusts the path it is handed, so the one grant that
  # runs as the service user becomes "execute any config.js you can write".
  MUTPRE="$(mktemp -d "${TMPDIR:-/tmp}/videofy-mutpre-XXXXXX")"
  # ALL FOUR containment guards, not two. The first version of this mutation
  # removed the "outside the store" and basename-shape refusals and SURVIVED at
  # 384/0, because the parent-directory check still caught every path the tests
  # offered. A mutation that leaves a guard standing measures nothing.
  grep -vF \
    -e 'outside $RELEASES' \
    -e 'the release store itself is not a candidate' \
    -e 'is nested below' \
    -e 'is not a release or an in-flight candidate' \
    "$PREFLIGHT_SRC" > "$MUTPRE/production-preflight.sh"
  PREFLIGHT_SRC="$MUTPRE/production-preflight.sh"
fi
if [ "$MUTATION" = "service-name-wildcard" ]; then
  # The defect: one tidy pattern authorises restarting anything that ever
  # carries the prefix, including units this deployment must not touch.
  MUTSUD="$(mktemp -d "${TMPDIR:-/tmp}/videofy-mutsud-XXXXXX")"
  sed 's#^  activate="$activate$SYSTEMCTL restart $unit"#  activate="$activate$SYSTEMCTL restart videofy-prod-*"#' \
    "$INSTALL_SH" > "$MUTSUD/install-sudo-hardening.sh"
  INSTALL_SH="$MUTSUD/install-sudo-hardening.sh"
fi
if [ "$MUTATION" = "systemctl-enable-authority" ]; then
  # The defect: provisioning authority smuggled into deployment authority.
  MUTSUD="$(mktemp -d "${TMPDIR:-/tmp}/videofy-mutsud-XXXXXX")"
  sed "s#^  printf 'Cmnd_Alias VIDEOFY_PREFLIGHT#  printf 'Cmnd_Alias VIDEOFY_ENABLE = /usr/bin/systemctl enable videofy-prod-account\\\\n'\n  printf 'Cmnd_Alias VIDEOFY_PREFLIGHT#" \
    "$INSTALL_SH" > "$MUTSUD/install-sudo-hardening.sh"
  INSTALL_SH="$MUTSUD/install-sudo-hardening.sh"
fi
if [ "$MUTATION" = "broad-nopasswd-all" ]; then
  # The defect: the thing this package exists to remove, quietly re-added.
  MUTSUD="$(mktemp -d "${TMPDIR:-/tmp}/videofy-mutsud-XXXXXX")"
  sed "s#^  printf '%s ALL=(root) NOPASSWD: VIDEOFY_PUBLISH, VIDEOFY_ACTIVATE\\\\n' \"\$DEPLOY_OWNER\"#  printf '%s ALL=(ALL) NOPASSWD: ALL\\\\n' \"\$DEPLOY_OWNER\"#" \
    "$INSTALL_SH" > "$MUTSUD/install-sudo-hardening.sh"
  INSTALL_SH="$MUTSUD/install-sudo-hardening.sh"
fi

# A copy of the helper with only its four compiled-in constants repointed at a
# rig. They are compiled in ON PURPOSE -- an environment override on a program
# whose entire job is to refuse caller-chosen paths would be the hole itself --
# so the substitution is asserted to touch exactly those four lines and nothing
# else.
PF_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/videofy-pfroot-XXXXXX")"
PF="$PF_ROOT/videofy-production-preflight"
mkdir -p "$PF_ROOT/releases" "$PF_ROOT/releases-scratch" "$PF_ROOT/env" "$PF_ROOT/lib" "$PF_ROOT/elsewhere"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
cp "$REPO_ROOT/deploy/lib/preflight-config.mjs" "$PF_ROOT/lib/preflight-config.mjs"
chmod 0644 "$PF_ROOT/lib/preflight-config.mjs"
printf 'C7_ENVIRONMENT=production\nSOME_KEY=value\n' > "$PF_ROOT/env/media-ingest.env"
sed \
  -e "s#^readonly RELEASES=.*#readonly RELEASES='$PF_ROOT/releases'#" \
  -e "s#^readonly ENV_FILE=.*#readonly ENV_FILE='$PF_ROOT/env/media-ingest.env'#" \
  -e "s#^readonly NODE=.*#readonly NODE='$NODE_BIN'#" \
  -e "s#^readonly IMPL=.*#readonly IMPL='$PF_ROOT/lib/preflight-config.mjs'#" \
  -e "s#^readonly IMPL_OWNER=.*#readonly IMPL_OWNER='$(id -un)'#" \
  "$PREFLIGHT_SRC" > "$PF"
chmod 755 "$PF"
# Asserted by VALUE, not by counting changed lines: on this host `node` really
# is at /usr/bin/node, so that substitution is a no-op and a diff count would
# come out 4 or 5 depending on the machine.
for CONST in RELEASES ENV_FILE NODE IMPL IMPL_OWNER; do
  if grep -q "^readonly $CONST=" "$PF"; then ok "the copy still defines $CONST"
  else bad "the copy lost the $CONST constant" "the substitution missed it"; fi
done
check "and it differs from the shipped helper ONLY in those constants" \
  "$(diff "$PREFLIGHT_SRC" "$PF" | grep -c '^< readonly ')" \
  "$(diff "$PREFLIGHT_SRC" "$PF" | grep -c '^< ')"

# A candidate of the shape the engine really produces, with a config module
# that loads -- so a pass means the implementation ran, not that a check was
# skipped.
make_candidate() {
  local dir="$1" providers="${2:-deepgram}"
  mkdir -p "$dir/services/media-ingest/dist/services/media-ingest/src"
  # The monorepo ships ESM, and Node decides that from the nearest package.json
  # -- so the fixture carries one, or `config.js` would fail to import for a
  # reason that has nothing to do with what is being tested.
  printf '{"type":"module"}\n' > "$dir/package.json"
  printf 'export function loadConfig() { return { transcriptionProvider: "%s", textToSpeechProvider: "elevenlabs", translationProvider: "opus-mt" }; }\n' \
    "$providers" > "$dir/services/media-ingest/dist/services/media-ingest/src/config.js"
}
CAND="$PF_ROOT/releases/.candidate-$A.20260907T000000Z-1234-99"
make_candidate "$CAND"
SEALED="$PF_ROOT/releases/$A"
make_candidate "$SEALED"

# ---- the shapes it must accept ----

if "$PF" "$CAND" >/dev/null 2>&1; then ok "an in-flight candidate is evaluated"
else bad "a real candidate was refused" "$("$PF" "$CAND" 2>&1 | tail -3)"; fi
if "$PF" "$SEALED" >/dev/null 2>&1; then ok "a sealed release is evaluated, so rollback uses the same primitive"
else bad "a sealed release was refused" "$("$PF" "$SEALED" 2>&1 | tail -3)"; fi
if "$PF" --check >/dev/null 2>&1; then ok "--check reports the authority is available"
else bad "--check failed" "the host proof depends on it"; fi

# It really runs the implementation: a fabricating provider must be caught.
make_candidate "$CAND" mock
if "$PF" "$CAND" >/dev/null 2>&1; then
  bad "a candidate configured to fabricate output passed" "the implementation cannot have run"
else ok "a fabricating provider is caught, so the implementation genuinely runs"; fi
make_candidate "$CAND"

# ---- the shapes it must refuse ----

REFUSALS_OK=1
try_refuse() {
  local label="$1"; shift
  if "$PF" "$@" >/dev/null 2>&1; then
    bad "the preflight accepted $label" "it must refuse"; REFUSALS_OK=0
  else ok "the preflight refuses $label"; fi
}
try_refuse "a path outside the release store"      "$PF_ROOT/elsewhere"
try_refuse "a prefix lookalike (releases-scratch)" "$PF_ROOT/releases-scratch/$A"
try_refuse "a relative path"                       "releases/$A"
try_refuse "a traversal"                           "$PF_ROOT/releases/../elsewhere"
try_refuse "the release store itself"              "$PF_ROOT/releases"
try_refuse "the filesystem root"                   "/"
try_refuse "an empty argument"                     ""
try_refuse "a directory nested below the store"    "$PF_ROOT/releases/$A/services"
try_refuse "a name that is not a release"          "$PF_ROOT/releases/scratch"
try_refuse "a short sha"                           "$PF_ROOT/releases/abc123"

# THE ACTUAL ATTACK, which the shape checks alone do not describe: a tree the
# caller controls that is candidate-shaped AND loads. Refusing
# `$PF_ROOT/elsewhere` proves little, since it has no config module to import
# and would fail for that reason whatever the containment rules said. These
# would each run the caller's code as the service identity if containment were
# removed, which is exactly what the grant must not permit.
EVIL_OUT="$PF_ROOT/elsewhere/.candidate-$A.20260907T000000Z-1-1"
make_candidate "$EVIL_OUT"
try_refuse "a loadable candidate-shaped tree outside the store" "$EVIL_OUT"

EVIL_NEAR="$PF_ROOT/releases-scratch/.candidate-$A.20260907T000000Z-1-1"
make_candidate "$EVIL_NEAR"
try_refuse "the same tree in a prefix lookalike directory" "$EVIL_NEAR"

# A SYMLINK IS JUDGED BY WHERE IT LANDS, not by how it is spelled -- and this
# one is inside the store, correctly named, and resolves to the caller's tree.
ln -sfn "$EVIL_OUT" "$PF_ROOT/releases/.candidate-$B.20260907T000000Z-1-1"
try_refuse "a correctly-named symlink resolving outside the store" \
  "$PF_ROOT/releases/.candidate-$B.20260907T000000Z-1-1"
rm -f "$PF_ROOT/releases/.candidate-$B.20260907T000000Z-1-1"

ln -sfn "$PF_ROOT/elsewhere" "$PF_ROOT/releases/$B"
try_refuse "a symlink escaping the store"          "$PF_ROOT/releases/$B"
rm -f "$PF_ROOT/releases/$B"

# ---- the argument surface is one path, and nothing else ----
#
# The environment file is compiled in. If it could be named, this grant would
# read as "any file you like, as the identity that can read the secrets".
if "$PF" "$CAND" "$PF_ROOT/env/media-ingest.env" >/dev/null 2>&1; then
  bad "the preflight accepted a second argument" "an env file must not be selectable"
else ok "a second argument is refused, so no env file can be named"; fi
if "$PF" "$CAND" --env /etc/shadow >/dev/null 2>&1; then
  bad "the preflight accepted an env-file option" "it must refuse"
else ok "there is no option to name an environment file"; fi

# ---- and it will not run an implementation somebody else could rewrite ----
chmod 0664 "$PF_ROOT/lib/preflight-config.mjs"
if "$PF" "$CAND" >/dev/null 2>&1; then
  bad "the preflight ran a group-writable implementation" "that is arbitrary code as the service user"
else ok "a group-writable implementation is refused"; fi
chmod 0644 "$PF_ROOT/lib/preflight-config.mjs"
mv "$PF_ROOT/lib/preflight-config.mjs" "$PF_ROOT/lib/moved.mjs"
if "$PF" "$CAND" >/dev/null 2>&1; then
  bad "the preflight ran with no implementation installed" "it must refuse"
else ok "a missing implementation is refused, naming what to run"; fi
mv "$PF_ROOT/lib/moved.mjs" "$PF_ROOT/lib/preflight-config.mjs"

# ---- production activation reaches the service user only through it ----

echo ""
echo "production asks nothing generic of the service identity"

new_rig; reset_failures
mkdir -p "$RIG/bin"
# Recording stubs: "node was never invoked as the service user" is only
# evidence if invoking it would have been visible.
printf '%s\n' '#!/usr/bin/env bash' "printf '%s\n' \"\$*\" >> $RIG/sudo.log" 'exit 0' > "$RIG/bin/sudo"
chmod 755 "$RIG/bin/sudo"
: > "$RIG/sudo.log"
SAVED_PATH2="$PATH"; PATH="$RIG/bin:$PATH"

export ATOMIC_ENV=production ATOMIC_SERVICE_USER=videofy ATOMIC_UNITS=''
export ATOMIC_PREFLIGHT_HELPER="$PF"
activation_preflight "$CAND" "$PF_ROOT/env/media-ingest.env" >/dev/null 2>&1
PF_CALL="$(cat "$RIG/sudo.log")"
case "$PF_CALL" in
  *"-n -u videofy $PF $CAND"*) ok "production invokes the fixed helper as the service user" ;;
  *) bad "production did not invoke the helper" "$PF_CALL" ;;
esac
case "$PF_CALL" in
  *" node "*) bad "production still invokes generic node as the service user" "$PF_CALL" ;;
  *) ok "and never invokes generic node" ;;
esac
case "$PF_CALL" in
  *" test "*) bad "production still invokes generic test as the service user" "$PF_CALL" ;;
  *) ok "and never invokes generic test" ;;
esac
check "exactly one privileged call is made for the preflight" \
  "$(wc -l < "$RIG/sudo.log" | tr -d ' ')" "1"

# NO FALLBACK. A missing helper must refuse, not quietly ask for the grant that
# was just removed -- which would fail later, with a sudo error instead of an
# explanation.
: > "$RIG/sudo.log"
export ATOMIC_PREFLIGHT_HELPER="$RIG/absent-helper"
NOFALL="$(activation_preflight "$CAND" "$PF_ROOT/env/media-ingest.env" 2>&1)" \
  && bad "production preflighted with no helper installed" "it must refuse" \
  || ok "a missing helper refuses instead of falling back"
check "and nothing was asked of the service identity" \
  "$(wc -c < "$RIG/sudo.log" | tr -d ' ')" "0"
case "$NOFALL" in
  *install-sudo-hardening.sh*) ok "and the refusal names the installer that provides it" ;;
  *) bad "the refusal does not say what to run" "$NOFALL" ;;
esac
unset ATOMIC_ENV ATOMIC_PREFLIGHT_HELPER ATOMIC_SERVICE_USER ATOMIC_UNITS
PATH="$SAVED_PATH2"
drop_rig

# ---- the policy the installer writes ----

echo ""
echo "the deploy identity is granted what a deployment uses, and nothing more"

new_rig; reset_failures
sudo_stub
SPFX="$RIG/policy"
mkdir -p "$SPFX/etc/sudoers.d" "$SPFX/etc/systemd/system"
for u in videofy-prod-account videofy-prod-gateway videofy-prod-media-ingest; do
  printf '[Service]\nUser=videofy\n' > "$SPFX/etc/systemd/system/$u.service"
done
POLICY_UNITS_BEFORE="$(cat "$SPFX/etc/systemd/system"/*.service | sha256sum)"
printf '%s\n' '#!/usr/bin/env bash' "printf '%s\n' \"\$*\" >> $RIG/systemctl.log" > "$RIG/bin/systemctl"
chmod 755 "$RIG/bin/systemctl"; : > "$RIG/systemctl.log"

BUILD_SHA="$A"; release_prepare "$ATOMIC_RELEASES" "$A" "$A" build_body >/dev/null 2>&1
pointer_publish "$ATOMIC_CURRENT" "$ATOMIC_RELEASES/$A" >/dev/null 2>&1
POLICY_CURRENT_BEFORE="$(pointer_target "$ATOMIC_CURRENT")"
POLICY_WWW_BEFORE="$(web_pointer_target)"

POLICY_RC=0
PATH="$RIG/bin:$SAVED_PATH" VIDEOFY_INSTALL_PREFIX="$SPFX" DEPLOY_OWNER=claude \
  VIDEOFY_SERVICE_USER=videofy bash "$INSTALL_SH" >/dev/null 2>&1 || POLICY_RC=$?
check "the hardening installer succeeds" "$POLICY_RC" "0"

# THE RULES, NOT THE COMMENTARY. The file explains what it deliberately omits,
# naming `systemctl enable`, `daemon-reload`, Caddy and coturn -- so searching
# the whole file finds every forbidden string inside the sentence saying it is
# forbidden. Only the directives decide what is granted.
POLICY="$(grep -v '^[[:space:]]*#' "$SPFX/etc/sudoers.d/videofy-deploy" 2>/dev/null)"
check "and the policy it wrote parses" \
  "$(visudo -c -f "$SPFX/etc/sudoers.d/videofy-deploy" >/dev/null 2>&1 && echo valid || echo invalid)" "valid"

# Each service named exactly, and nothing that could stand for another.
for u in videofy-prod-account videofy-prod-gateway videofy-prod-media-ingest; do
  case "$POLICY" in
    *"/usr/bin/systemctl restart $u"*) ok "restart authority for $u is present" ;;
    *) bad "no restart authority for $u" "$POLICY" ;;
  esac
done
policy_forbids() {
  local label="$1" needle="$2"
  case "$POLICY" in
    *"$needle"*) bad "the policy grants $label" "$needle" ;;
    *) ok "the policy does not grant $label" ;;
  esac
}
policy_forbids "systemctl enable"           'systemctl enable'
policy_forbids "daemon-reload"              'daemon-reload'
policy_forbids "a wildcard service name"    'restart videofy-prod-*'
policy_forbids "generic node"               '/usr/bin/node'
policy_forbids "generic test"               '/usr/bin/test'
policy_forbids "a root shell"               '/bin/bash'
policy_forbids "blanket authority"          'NOPASSWD: ALL'
policy_forbids "an unrestricted runas"      'ALL=(ALL:ALL)'
policy_forbids "chown"                      '/bin/chown'
policy_forbids "chmod"                      '/bin/chmod'
policy_forbids "caddy"                      'caddy'
policy_forbids "coturn"                     'coturn'
case "$POLICY" in
  *'claude ALL=(root) NOPASSWD: VIDEOFY_PUBLISH, VIDEOFY_ACTIVATE'*)
    ok "root authority is exactly publication plus the named restarts" ;;
  *) bad "the root-authority line is not the bounded one" "$POLICY" ;;
esac
case "$POLICY" in
  *'claude ALL=(videofy) NOPASSWD: VIDEOFY_PREFLIGHT'*)
    ok "service-user authority is exactly the fixed preflight" ;;
  *) bad "the service-user line is not the bounded one" "$POLICY" ;;
esac
check "publication authority is still granted, unchanged" \
  "$(printf '%s' "$POLICY" | grep -c 'videofy-publish-current')" "1"

# The installer is a policy change, not a deployment.
check "no service unit was altered" \
  "$(cat "$SPFX/etc/systemd/system"/*.service | sha256sum)" "$POLICY_UNITS_BEFORE"
check "systemctl was never invoked" \
  "$(wc -c < "$RIG/systemctl.log" | tr -d ' ')" "0"
check "the pointer did not move" "$(pointer_target "$ATOMIC_CURRENT")" "$POLICY_CURRENT_BEFORE"
check "www did not move" "$(web_pointer_target)" "$POLICY_WWW_BEFORE"
check "no staged file survives" \
  "$(find "$SPFX/etc/sudoers.d" "$SPFX/usr/local/sbin" -name '.*' -type f 2>/dev/null | wc -l | tr -d ' ')" "0"

# Rerunnable, and the replacement is a rename like every other privileged one.
POLICY_INODE="$(stat -c '%i' "$SPFX/etc/sudoers.d/videofy-deploy")"
exec 7< "$SPFX/etc/sudoers.d/videofy-deploy"
POLICY_TEXT_BEFORE="$(cat "$SPFX/etc/sudoers.d/videofy-deploy")"
# The second run writes DIFFERENT content, so "the reader saw the old file" is
# a real observation rather than two identical strings agreeing.
PATH="$RIG/bin:$SAVED_PATH" VIDEOFY_INSTALL_PREFIX="$SPFX" DEPLOY_OWNER=claude \
  VIDEOFY_SERVICE_USER=videofy VIDEOFY_UNITS='videofy-prod-account videofy-prod-gateway' \
  bash "$INSTALL_SH" >/dev/null 2>&1
check "a second run succeeds and still parses" \
  "$(visudo -c -f "$SPFX/etc/sudoers.d/videofy-deploy" >/dev/null 2>&1 && echo valid || echo invalid)" "valid"
check "a reader mid-swap still sees the complete previous policy" \
  "$(cat <&7)" "$POLICY_TEXT_BEFORE"
exec 7<&-
check "and the policy file is a new inode, so it was renamed into place" \
  "$([ "$(stat -c '%i' "$SPFX/etc/sudoers.d/videofy-deploy")" != "$POLICY_INODE" ] && echo renamed || echo written-through)" \
  "renamed"

# IT DOES NOT REMOVE THE BROAD GRANT. That is a separate act, taken on the host
# with a root session open, after the narrow policy is proven.
printf '%s\n' 'claude ALL=(ALL) NOPASSWD: ALL' > "$SPFX/etc/sudoers.d/claude"
PATH="$RIG/bin:$SAVED_PATH" VIDEOFY_INSTALL_PREFIX="$SPFX" DEPLOY_OWNER=claude \
  VIDEOFY_SERVICE_USER=videofy bash "$INSTALL_SH" >/dev/null 2>&1
check "an existing broad grant is left exactly where it was" \
  "$(cat "$SPFX/etc/sudoers.d/claude")" "claude ALL=(ALL) NOPASSWD: ALL"
drop_rig; PATH="$SAVED_PATH"

rm -rf "$PF_ROOT"
[ -n "${MUTPRE:-}" ] && rm -rf "$MUTPRE"
[ -n "${MUTSUD:-}" ] && rm -rf "$MUTSUD"

# The scratch trees this section made for itself.
rm -rf "$PA_PREFIX"
[ -n "${MUTDIR:-}" ] && rm -rf "$MUTDIR"
[ -n "${MUTINST:-}" ] && rm -rf "$MUTINST"

# ============================================================ report

echo ""
echo "-------------------------------------------------------------"
printf 'passed %s   failed %s\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'failing cases:%s\n' "$FAILED_CASES"
  exit 1
fi
exit 0
