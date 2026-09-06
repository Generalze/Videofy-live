#!/usr/bin/env bash
# @author masterzee001
#
# Deploy by preparing a release nothing can see, then making it real at once.
#
#   bash deploy/atomic-deploy.sh production <full-40-char-sha>
#   bash deploy/atomic-deploy.sh production prepare <full-40-char-sha>
#   bash deploy/atomic-deploy.sh production rollback <full-40-char-sha>
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
#
# SYSTEMD IS NOT MODIFIED BY A RELEASE. This installs no unit, reloads no
# daemon and removes no drop-in. It reads what systemd is enforcing and refuses
# if that disagrees with the deployment contract. Changing a unit is a
# separate, separately reviewed act -- which is what stops a refused deploy
# leaving new units behind, as the old model did.
set -euo pipefail

ENV_NAME="${1:?usage: atomic-deploy.sh <staging|production> <sha|prepare <sha>|rollback <sha>|state>}"
ACTION="${2:?usage: atomic-deploy.sh <env> <sha|prepare <sha>|rollback <sha>|state>}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."
# shellcheck source=./lib/env.sh
. deploy/lib/env.sh
videofy_env "$ENV_NAME"

: "${VIDEOFY_ROOT:?environment did not set VIDEOFY_ROOT}"
: "${VIDEOFY_SSH_HOST:?environment did not set VIDEOFY_SSH_HOST}"

REMOTE_LIB="/tmp/videofy-atomic-$ENV_NAME"

# THE FOUNDER-LOCKED PRODUCTION RULE, PRESERVED.
#
# Production accepts ONLY a full 40-character lowercase SHA. A branch name is a
# moving target and a tag is a label somebody can repoint, so neither is a
# statement about which bytes were approved -- and the whole provenance chain
# from CI to this command is written in full SHAs. Staging may still take a ref,
# because staging is where you find out what a ref contains.
#
# Resolved and then COMPARED, because `git rev-parse` on a 40-char string that
# is not a commit in this repository will happily echo it straight back.
resolve_production_sha() {
  local requested="$1"
  case "$requested" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *)
      echo "REFUSED: production takes a full 40-character lowercase SHA, not '$requested'." >&2
      echo "  A branch or tag is a moving target; the approval was for bytes." >&2
      exit 1 ;;
  esac
  local resolved
  resolved="$(git rev-parse --verify --quiet "$requested^{commit}" || true)"
  if [ -z "$resolved" ]; then
    echo "REFUSED: $requested is not a commit in this repository." >&2
    exit 1
  fi
  if [ "$resolved" != "$requested" ]; then
    echo "REFUSED: $requested resolved to $resolved; they must be identical." >&2
    exit 1
  fi
  printf '%s' "$resolved"
}

resolve_sha() {
  if [ "$ENV_NAME" = "production" ]; then
    resolve_production_sha "$1"
  else
    git rev-parse "$1^{commit}"
  fi
}

# ---------------------------------------------------------------- read-only

if [ "$ACTION" = "state" ]; then
  # shellcheck disable=SC2029
  ssh "$VIDEOFY_SSH_HOST" "
    . $REMOTE_LIB/release-engine.sh 2>/dev/null || { echo 'engine not installed on host'; exit 1; }
    release_state '$VIDEOFY_ROOT/releases' '$VIDEOFY_ROOT/current' '$VIDEOFY_ROOT/www'
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

# The public smoke, run from HERE rather than on the box, because the thing
# being tested is the path a visitor takes: through Cloudflare, through Caddy,
# to the service. Reusing deploy/production/smoke.sh rather than restating what
# "the site works" means in a second place that can drift from the first.
public_smoke() {
  if [ "${DEPLOY_SKIP_SMOKE:-0}" = "1" ]; then
    echo "[$ENV_NAME] smoke SKIPPED by DEPLOY_SKIP_SMOKE=1 -- not provenance-complete"
    return 0
  fi
  bash "$HERE/production/smoke.sh" "$ENV_NAME"
}

remote_rollback() {
  local target="$1"
  # shellcheck disable=SC2029
  ssh "$VIDEOFY_SSH_HOST" bash -s "$ENV_NAME" "$target" "$VIDEOFY_ROOT" "$REMOTE_LIB" \
    "$(printf '%s' "$VIDEOFY_UNITS" | tr ' ' ',')" \
    "$VIDEOFY_ACCOUNT_PORT" "$VIDEOFY_GATEWAY_PORT" "$VIDEOFY_INGEST_PORT" <<'ROLLBACK'
set -euo pipefail
ENV_NAME="$1"; TARGET="$2"; ROOT="$3"; LIB="$4"; UNITS_CSV="$5"
ACCOUNT_PORT="$6"; GATEWAY_PORT="$7"; INGEST_PORT="$8"
export ATOMIC_ROOT="$ROOT" ATOMIC_RELEASES="$ROOT/releases"
export ATOMIC_CURRENT="$ROOT/current" ATOMIC_WWW="$ROOT/www" ATOMIC_ENV="$ENV_NAME"
export ATOMIC_UNITS="$(printf '%s' "$UNITS_CSV" | tr ',' ' ')"
. "$LIB/atomic-release.sh"
. "$LIB/activation.sh"
ATOMIC_FN_RESTART=activation_restart
ATOMIC_FN_HEALTH=activation_health
ATOMIC_FN_RUNNING=activation_running_release
# The public smoke is NOT run here -- it belongs to the machine that can reach
# the public edge, and the caller runs it after this returns.
atomic_rollback_transition "$TARGET"
ROLLBACK
}

# ------------------------------------------------------------------ rollback

if [ "$ACTION" = "rollback" ]; then
  TARGET="$(resolve_sha "${3:?usage: atomic-deploy.sh <env> rollback <sha>}")"
  echo "[$ENV_NAME] rolling back to $TARGET"
  if ! remote_rollback "$TARGET"; then
    echo "ROLLBACK FAILED. The state above is what the host reports."
    exit 1
  fi
  if ! public_smoke; then
    echo "ROLLBACK INCOMPLETE: $TARGET is published and healthy on the box, but the"
    echo "  public smoke failed. The edge, not the release, is the thing to look at."
    exit 1
  fi
  echo "[$ENV_NAME] ROLLED BACK to $TARGET"
  exit 0
fi

# ------------------------------------------------------------------- prepare

PREPARE_ONLY=no
if [ "$ACTION" = "prepare" ]; then
  PREPARE_ONLY=yes
  SHA="$(resolve_sha "${3:?usage: atomic-deploy.sh <env> prepare <sha>}")"
else
  SHA="$(resolve_sha "$ACTION")"
fi
echo "[$ENV_NAME] candidate $SHA (prepare-only: $PREPARE_ONLY)"

BUNDLE="/tmp/videofy-atomic-$ENV_NAME.bundle"
git bundle create "$BUNDLE" "$SHA" 2>&1 | grep -v '^warning' || true
[ -s "$BUNDLE" ] || { echo "DEPLOY FAILED: empty bundle"; exit 1; }
scp -q "$BUNDLE" "$VIDEOFY_SSH_HOST:/tmp/videofy-atomic.bundle"

REMOTE_STATUS=0
# shellcheck disable=SC2029
ssh "$VIDEOFY_SSH_HOST" bash -s \
  "$ENV_NAME" "$SHA" "$VIDEOFY_ROOT" "$REMOTE_LIB" "$VIDEOFY_PUBLIC_ORIGIN" \
  "$(printf '%s' "$VIDEOFY_UNITS" | tr ' ' ',')" "$VIDEOFY_ENV_DIR" \
  "$VIDEOFY_ACCOUNT_PORT" "$VIDEOFY_GATEWAY_PORT" "$VIDEOFY_INGEST_PORT" "$PREPARE_ONLY" <<'REMOTE' || REMOTE_STATUS=$?
set -euo pipefail
ENV_NAME="$1"; SHA="$2"; ROOT="$3"; LIB="$4"; PUBLIC_ORIGIN="$5"
UNITS_CSV="$6"; ENV_DIR="$7"; ACCOUNT_PORT="$8"; GATEWAY_PORT="$9"; INGEST_PORT="${10}"
PREPARE_ONLY="${11}"

export ATOMIC_ROOT="$ROOT"
export ATOMIC_RELEASES="$ROOT/releases"
export ATOMIC_CURRENT="$ROOT/current"
export ATOMIC_WWW="$ROOT/www"
export ATOMIC_ENV="$ENV_NAME"
export ATOMIC_UNITS="$(printf '%s' "$UNITS_CSV" | tr ',' ' ')"
export ATOMIC_ENV_FILE="$ENV_DIR/media-ingest.env"
export ACCOUNT_PORT GATEWAY_PORT INGEST_PORT PUBLIC_ORIGIN

. "$LIB/atomic-release.sh"
. "$LIB/activation.sh"

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
  # `stage-webapps.sh` copied each app into the served directory as it built
  # and ran its endpoint guard afterwards -- so a bundle that failed the guard
  # had already been public for the length of the build. Here the apps are
  # staged into the candidate's own `www`, which nothing serves, and become
  # visible only when `current` moves.
  ( cd "$candidate" && WWW_DIR="$candidate/www" PUBLIC_ORIGIN="$PUBLIC_ORIGIN" \
      bash deploy/lib/stage-webapps.sh 2>&1 | tail -3 ) || return 1
  return 0
}

ATOMIC_FN_BUILD=prepare
ATOMIC_FN_PREFLIGHT=activation_preflight
ATOMIC_FN_RESTART=activation_restart
ATOMIC_FN_HEALTH=activation_health
ATOMIC_FN_RUNNING=activation_running_release
# ATOMIC_FN_SMOKE is deliberately UNSET on the box: the public edge is reached
# from the machine running this command, and the caller runs the smoke there.

if [ "$PREPARE_ONLY" = "yes" ]; then
  atomic_prepare_only "$SHA" "$SHA"
  exit $?
fi

# THE CONVERGENCE PRECONDITION. Until the one-time migration has run, the
# pointer does not exist and the units still name a git tree this script does
# not manage. Refusing here is the difference between "not converged yet" and
# "converged and broken", which are not the same problem and must not produce
# the same error three steps later.
if [ ! -L "$ATOMIC_CURRENT" ] && [ ! -e "$ATOMIC_CURRENT" ]; then
  echo "REFUSED: $ATOMIC_CURRENT does not exist, so this host has not been converged."
  echo "  Build the first release with:  atomic-deploy.sh $ENV_NAME prepare $SHA"
  echo "  then follow docs/ATOMIC_PRODUCTION_CONVERGENCE.md. Nothing was changed."
  exit 1
fi

atomic_deploy "$SHA" "$SHA"
REMOTE

if [ "$REMOTE_STATUS" -ne 0 ]; then
  echo "[$ENV_NAME] FAILED on the box (exit $REMOTE_STATUS)"
  exit "$REMOTE_STATUS"
fi

if [ "$PREPARE_ONLY" = "yes" ]; then
  echo "[$ENV_NAME] PREPARED $SHA -- nothing published, nothing restarted"
  exit 0
fi

# STEP: PUBLIC SMOKE, from outside, through Cloudflare and Caddy.
#
# A deployment is not complete because localhost answered 200. A service can be
# healthy on loopback while the edge serves a stale shell or refuses a route --
# which is exactly the failure a loopback probe is blind to.
#
# AND A FAILURE HERE IS A ROLLBACK, not a message. Leaving the new release
# published while telling the operator to roll back is how a bad release stays
# live for as long as it takes somebody to read the log.
if ! public_smoke; then
  echo "DEPLOY FAILED: $SHA is healthy on the box but the public smoke failed."
  PREVIOUS="$(ssh "$VIDEOFY_SSH_HOST" "sed -n 's/^| previous | \`\\(.*\\)\` |$/\\1/p' '$VIDEOFY_ROOT/DEPLOY-STATE.md' 2>/dev/null | head -1")"
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "none" ] && [ "$PREVIOUS" != "rolled-back" ]; then
    echo "  rolling back to $PREVIOUS"
    remote_rollback "$PREVIOUS" || { echo "  ROLLBACK ALSO FAILED -- inspect the host"; exit 1; }
    public_smoke || { echo "  rolled back, but the public edge still fails -- the edge is the fault"; exit 1; }
    echo "[$ENV_NAME] ROLLED BACK to $PREVIOUS after smoke failure"
  else
    echo "  no previous sealed release recorded; $SHA remains published."
  fi
  exit 1
fi

echo "[$ENV_NAME] DEPLOYED $SHA"
