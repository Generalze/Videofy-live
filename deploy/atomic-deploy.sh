#!/usr/bin/env bash
# @author masterzee001
#
# Deploy by preparing a release nothing can see, then making it real at once.
#
#   bash deploy/atomic-deploy.sh production <branch-or-sha>
#   bash deploy/atomic-deploy.sh production rollback <sha>
#   bash deploy/atomic-deploy.sh production state
#
# HOW THIS DIFFERS FROM deploy/deploy.sh, which it replaces for any converged
# environment. The old script checked the target SHA out into the tree the
# services were running from, and only then built, reconciled units and ran its
# gates. Every one of those steps was visible to a restart -- and on this host
# something restarts services without being asked: unattended-upgrades stopped
# and started the production gateway at 06:19 on 2026-09-05. A deploy in
# flight, or one about to REFUSE at a gate, would have handed that restart code
# which had passed nothing.
#
# Here, nothing the services resolve is touched until every gate has passed.
# The release is built in `releases/<sha>`, which no pointer names; the pointer
# moves once, by rename; and a failure before that rename is invisible to the
# running system.
#
# SYSTEMD IS NOT MODIFIED BY A RELEASE. This script installs no unit, reloads
# no daemon and removes no drop-in. It reads what systemd is enforcing and
# refuses if that disagrees with the deployment contract. Changing a unit is a
# separate, separately reviewed act -- which is what stops a refused deploy
# leaving new units behind, as the old model did.
set -euo pipefail

ENV_NAME="${1:?usage: atomic-deploy.sh <staging|production> <ref|rollback <sha>|state>}"
ACTION="${2:?usage: atomic-deploy.sh <env> <ref|rollback <sha>|state>}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=./lib/env.sh
. deploy/lib/env.sh
videofy_env "$ENV_NAME"

: "${VIDEOFY_ROOT:?environment did not set VIDEOFY_ROOT}"
: "${VIDEOFY_SSH_HOST:?environment did not set VIDEOFY_SSH_HOST}"

REMOTE_LIB="/tmp/videofy-atomic-$ENV_NAME"

# ---------------------------------------------------------------- read-only

if [ "$ACTION" = "state" ]; then
  # shellcheck disable=SC2029
  ssh "$VIDEOFY_SSH_HOST" "
    ATOMIC_RELEASES='$VIDEOFY_ROOT/releases'
    ATOMIC_CURRENT='$VIDEOFY_ROOT/current'
    ATOMIC_WWW='$VIDEOFY_ROOT/www'
    . $REMOTE_LIB/release-engine.sh 2>/dev/null || { echo 'engine not installed on host'; exit 1; }
    release_state \"\$ATOMIC_RELEASES\" \"\$ATOMIC_CURRENT\" \"\$ATOMIC_WWW\"
  "
  exit 0
fi

# ---------------------------------------------------------- ship the engine

# The libraries go to /tmp, never under the deployment root: a deployment
# mechanism that installs itself into the tree it deploys is one more thing
# that can be half-updated when something fails.
tar -czf "/tmp/videofy-atomic-lib.tgz" deploy/lib
scp -q "/tmp/videofy-atomic-lib.tgz" "$VIDEOFY_SSH_HOST:/tmp/videofy-atomic-lib.tgz"
ssh "$VIDEOFY_SSH_HOST" "rm -rf '$REMOTE_LIB' && mkdir -p '$REMOTE_LIB' && \
  tar -xzf /tmp/videofy-atomic-lib.tgz -C /tmp && mv /tmp/deploy/lib/* '$REMOTE_LIB/' && rm -rf /tmp/deploy"

# ------------------------------------------------------------------ rollback

if [ "$ACTION" = "rollback" ]; then
  TARGET="${3:?usage: atomic-deploy.sh <env> rollback <sha>}"
  echo "[$ENV_NAME] rolling back to $TARGET"
  # shellcheck disable=SC2029
  ssh "$VIDEOFY_SSH_HOST" "
    set -euo pipefail
    export ATOMIC_ROOT='$VIDEOFY_ROOT' ATOMIC_RELEASES='$VIDEOFY_ROOT/releases'
    export ATOMIC_CURRENT='$VIDEOFY_ROOT/current' ATOMIC_WWW='$VIDEOFY_ROOT/www'
    . $REMOTE_LIB/release-engine.sh
    # One pointer, so a rollback is one rename -- the site comes back with the
    # API because \`www\` resolves through \`current\` rather than being its own
    # release pointer.
    release_rollback \"\$ATOMIC_RELEASES\" '$TARGET' \"\$ATOMIC_CURRENT\"
    echo 'current -> '\"\$(pointer_target \"\$ATOMIC_CURRENT\")\"
    echo 'RESTART THE SERVICES: they are still running the release you rolled away from.'
  "
  exit 0
fi

# ------------------------------------------------------------------- deploy

SHA="$(git rev-parse "$ACTION^{commit}")"
echo "[$ENV_NAME] candidate $SHA"

BUNDLE="/tmp/videofy-atomic-$ENV_NAME.bundle"
git bundle create "$BUNDLE" "$SHA" 2>&1 | grep -v '^warning' || true
[ -s "$BUNDLE" ] || { echo "DEPLOY FAILED: empty bundle"; exit 1; }
scp -q "$BUNDLE" "$VIDEOFY_SSH_HOST:/tmp/videofy-atomic.bundle"

# shellcheck disable=SC2029
ssh "$VIDEOFY_SSH_HOST" bash -s \
  "$ENV_NAME" "$SHA" "$VIDEOFY_ROOT" "$REMOTE_LIB" "$VIDEOFY_PUBLIC_ORIGIN" \
  "$(printf '%s' "$VIDEOFY_UNITS" | tr ' ' ',')" "$VIDEOFY_ENV_DIR" \
  "$VIDEOFY_ACCOUNT_PORT" "$VIDEOFY_GATEWAY_PORT" "$VIDEOFY_INGEST_PORT" <<'REMOTE'
set -euo pipefail
ENV_NAME="$1"; SHA="$2"; ROOT="$3"; LIB="$4"; PUBLIC_ORIGIN="$5"
UNITS_CSV="$6"; ENV_DIR="$7"; ACCOUNT_PORT="$8"; GATEWAY_PORT="$9"; INGEST_PORT="${10}"
UNITS="$(printf '%s' "$UNITS_CSV" | tr ',' ' ')"

export ATOMIC_ROOT="$ROOT"
export ATOMIC_RELEASES="$ROOT/releases"
export ATOMIC_CURRENT="$ROOT/current"
export ATOMIC_WWW="$ROOT/www"
export ATOMIC_ENV="$ENV_NAME"

. "$LIB/atomic-release.sh"

# THE CONVERGENCE PRECONDITION. Until the one-time migration has run, the
# pointers do not exist and the units still name a git tree this script does
# not manage. Refusing here is the difference between "not converged yet" and
# "converged and broken", which are not the same problem and must not produce
# the same error three steps later.
if [ ! -L "$ATOMIC_CURRENT" ] && [ ! -e "$ATOMIC_CURRENT" ]; then
  echo "REFUSED: $ATOMIC_CURRENT does not exist, so this host has not been converged."
  echo "  Run the one-time convergence in docs/ATOMIC_PRODUCTION_CONVERGENCE.md first."
  echo "  Nothing has been changed."
  exit 1
fi

# Everything below runs inside a directory nothing points at.
prepare() {
  candidate="$1"
  echo "preparing $SHA in $candidate"
  git init -q "$candidate"
  git -C "$candidate" fetch -q /tmp/videofy-atomic.bundle "$SHA"
  git -C "$candidate" checkout -q --detach "$SHA"
  actual="$(git -C "$candidate" rev-parse HEAD)"
  [ "$actual" = "$SHA" ] || { echo "REFUSED: candidate is $actual, expected $SHA"; return 1; }

  ( cd "$candidate" && npm ci --no-audit --no-fund --silent 2>&1 | tail -2 ) || return 1
  [ -e "$candidate/node_modules/@videofy-live/language-catalogue" ] || \
    ln -s ../../packages/language-catalogue "$candidate/node_modules/@videofy-live/language-catalogue"
  ( cd "$candidate" && npm run build --silent 2>&1 | tail -3 ) || return 1

  # WEB ASSETS INTO THE RELEASE, NOT INTO THE LIVE ROOT.
  #
  # `stage-webapps.sh` copied each app into the served directory as it built,
  # and ran its own endpoint guard afterwards -- so a bundle that failed the
  # guard had already been public for the length of the build. Here the apps
  # are staged into the candidate's own `www`, which nothing serves, and become
  # visible only when the web pointer moves.
  ( cd "$candidate" && WWW_DIR="$candidate/www" PUBLIC_ORIGIN="$PUBLIC_ORIGIN" \
      bash deploy/lib/stage-webapps.sh 2>&1 | tail -3 ) || return 1
  return 0
}

# The production-only startup rules, evaluated against the real environment
# file, by a process that starts nothing.
preflight() {
  node "$LIB/preflight-config.mjs" "$1" "$ENV_DIR/media-ingest.env"
}

restart_services() {
  echo "restarting: $UNITS"
  # shellcheck disable=SC2086
  sudo -n systemctl restart $UNITS
  for u in $UNITS; do
    state="$(systemctl is-active "$u" || true)"
    [ "$state" = "active" ] || { echo "unit $u is $state"; return 1; }
  done
  return 0
}

verify() {
  failed=0
  for probe in "account $ACCOUNT_PORT" "gateway $GATEWAY_PORT" "media-ingest $INGEST_PORT"; do
    set -- $probe
    code=000
    for _ in $(seq 1 15); do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$2/health" || true)"
      [ "$code" = "200" ] && break
      sleep 2
    done
    echo "  $1 :$2/health $code"
    [ "$code" = "200" ] || failed=1
  done
  return "$failed"
}

# shellcheck disable=SC2086
atomic_deploy "$SHA" "$SHA" prepare "$ENV_DIR/media-ingest.env" preflight \
  restart_services verify $UNITS
REMOTE
