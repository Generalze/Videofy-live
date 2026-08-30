#!/usr/bin/env bash
# @author masterzee001
#
# Deploy ONE environment on c7-eu-01: git bundle over scp, then build, restart
# and verify on the box. Generalised from the staging deploy of 30 Aug 2026,
# which encodes that night's lessons; each of them is marked below.
#
#   bash deploy/deploy.sh staging     <branch-or-sha>
#   bash deploy/deploy.sh production  <full-40-character-sha>
#
# Rollback is the same command with the previous SHA. The box appends every
# verified release to <root>/releases.log, so the previous SHA is one line up.
#
# PROVENANCE, FOUNDER RULING LOCKED 30 Aug 2026: "requested full SHA ->
# checkout -> actual HEAD == requested (else FAIL) -> build -> activate ->
# health -> running release == requested (else FAIL) -> smoke". Those eight
# steps are in that order below, each marked. Production refuses a ref that is
# not already a full SHA: "the exact approved SHA" is not a property a branch
# name has, because a branch moves between the approval and the deploy and
# nothing in the transcript would show that it had.
#
# What this never does: touch an env file, print a secret, deploy to an
# environment that was not named on the command line, or print DEPLOYED while
# the previous release is still the one serving traffic.
#
#   DEPLOY_SKIP_SMOKE=1   skip the final public smoke (only when the public
#                         hostname does not resolve yet -- it still deploys,
#                         but the deploy is then NOT provenance-complete)
set -euo pipefail

ENV_NAME="${1:?usage: deploy.sh <staging|production> <branch-or-sha>}"
REF="${2:?usage: deploy.sh <staging|production> <branch-or-sha>}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib/env.sh
. "$HERE/lib/env.sh"
videofy_env "$ENV_NAME"

SCRATCH="${VIDEOFY_DEPLOY_SCRATCH:-${TMPDIR:-/tmp}}"
BUNDLE="$SCRATCH/videofy-deploy-$VIDEOFY_ENV.bundle"
DEPLOY_REF="refs/deploy/$VIDEOFY_ENV"

cd "$REPO"
# STEP 1 -- REQUESTED FULL SHA. A branch name OR a commit: a rollback names a
# SHA, and `git bundle` needs a ref to carry it, so the commit is pinned under
# a temporary ref of our own.
if [ "$VIDEOFY_ENV" = "production" ] && ! printf '%s' "$REF" | grep -qE '^[0-9a-f]{40}$'; then
  echo "DEPLOY REFUSED: production takes the full 40-character approved SHA, not '$REF'."
  echo "  Resolve it and read it back before you use it:"
  echo "    git rev-parse --verify ${REF}^{commit}"
  exit 1
fi
SHA="$(git rev-parse --verify "${REF}^{commit}")"
git update-ref "$DEPLOY_REF" "$SHA"
trap 'git update-ref -d "$DEPLOY_REF" 2>/dev/null || true' EXIT

if [ "$VIDEOFY_ENV" = "production" ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  # The bundle carries commits, not the working tree, so local edits would not
  # ship anyway -- but a production deploy from a dirty tree is one where what
  # was tested and what was shipped may differ. Say so instead of guessing.
  echo "note: working tree has uncommitted changes; deploying committed $SHA only"
fi

git bundle create "$BUNDLE" "$DEPLOY_REF" 2>&1 | grep -v "^warning" || true
[ -s "$BUNDLE" ] || { echo "DEPLOY FAILED: no bundle"; exit 1; }
echo "[$VIDEOFY_ENV] bundle $(stat -c %s "$BUNDLE") bytes for $SHA -> $VIDEOFY_SSH_HOST"
scp -q "$BUNDLE" "$VIDEOFY_SSH_HOST:/tmp/videofy-$VIDEOFY_ENV.bundle" || { echo "DEPLOY FAILED: scp"; exit 1; }

ssh "$VIDEOFY_SSH_HOST" bash -s \
  "$VIDEOFY_ENV" "$SHA" "$DEPLOY_REF" "$VIDEOFY_ROOT" "$VIDEOFY_APP_DIR" "$VIDEOFY_WWW_DIR" \
  "$VIDEOFY_PUBLIC_ORIGIN" "$VIDEOFY_UNITS" \
  "$VIDEOFY_ACCOUNT_PORT" "$VIDEOFY_GATEWAY_PORT" "$VIDEOFY_INGEST_PORT" <<'REMOTE'
set -euo pipefail
ENV_NAME="$1"; SHA="$2"; DEPLOY_REF="$3"; ROOT="$4"; APP_DIR="$5"; WWW_DIR="$6"
PUBLIC_ORIGIN="$7"; UNITS="$8"; ACCOUNT_PORT="$9"; GATEWAY_PORT="${10}"; INGEST_PORT="${11}"
BUNDLE="/tmp/videofy-$ENV_NAME.bundle"

[ -d "$APP_DIR/.git" ] || { echo "DEPLOY FAILED: $APP_DIR is not a git tree; run deploy/$ENV_NAME/install.sh first"; exit 1; }
cd "$APP_DIR"
PREVIOUS="$(git rev-parse HEAD 2>/dev/null || echo none)"
echo "[$ENV_NAME] previous release: $PREVIOUS"

# Lesson: earlier deploys run with sudo left root-owned files that blocked the
# next checkout (unable to unlink) and the next build (EACCES on dist).
sudo -n chown -R "$(id -u):$(id -g)" . 2>/dev/null || true
# Lesson: npm rewrites the lockfile on the box; a dirty lockfile blocks checkout.
git checkout -q -- package-lock.json 2>/dev/null || true
# STEP 2 -- CHECKOUT.
git fetch -q "$BUNDLE" "$DEPLOY_REF"
git checkout -q --detach FETCH_HEAD
# STEP 3 -- HEAD == REQUESTED, else FAIL. Founder ruling 30 Aug 2026: expected
# SHA != actual SHA is a deploy FAILURE, not a line for a human to notice.
ACTUAL="$(git rev-parse HEAD)"
if [ "$ACTUAL" != "$SHA" ]; then echo "DEPLOY FAILED: checked out $ACTUAL, expected $SHA"; exit 1; fi
echo "[$ENV_NAME] checked out $ACTUAL (verified)"
# The moment the new code landed. Any service whose main process started
# BEFORE this is still running the previous release, whatever the tree says.
CHECKOUT_EPOCH="$(date +%s)"

# STEP 4 -- BUILD (server bundles and the four web apps; both are "the build",
# and staging the apps AFTER the restart would serve the old shell for the
# seconds in between).

npm ci --no-audit --no-fund --silent 2>&1 | tail -2 || npm install --no-audit --no-fund --silent 2>&1 | tail -2
[ -e node_modules/@videofy-live/language-catalogue ] || ln -s ../../packages/language-catalogue node_modules/@videofy-live/language-catalogue

# THE ROOT BUILD, NOT A LIST KEPT HERE.
#
# This used to name eleven packages and four services. Two of them drifted out
# of it within a week -- `services/ai-registry` (a library that lives under
# services/, so a packages-only loop skipped it) and
# `packages/conference-authority` -- and each failed the same way: a module
# that "does not provide an export" for code that plainly has it, or a type
# declaration that cannot be found. On a developer's machine a stale dist hides
# both; on a fresh production tree neither is survivable.
#
# The root `build` script is the authoritative, dependency-ORDERED list, and
# scripts/check-build-order.mjs fails the test chain if that order is ever
# wrong. Deferring to it means a new package is deployable the day it is added
# rather than the day somebody remembers this file.
npm run build --silent 2>&1 | tail -3

if [ -f deploy/lib/stage-webapps.sh ]; then
  WWW_DIR="$WWW_DIR" PUBLIC_ORIGIN="$PUBLIC_ORIGIN" bash deploy/lib/stage-webapps.sh 2>&1 | tail -5
elif [ "$ENV_NAME" = "staging" ]; then
  # A commit older than deploy/lib: the staging-only script it was generalised from.
  bash scripts/stage-webapps.sh 2>&1 | tail -5
else
  echo "DEPLOY FAILED: $SHA predates deploy/lib/stage-webapps.sh and cannot stage $ENV_NAME web apps"; exit 1
fi

# Lesson: the deploy user owns the tree for writing; the services run as
# another user and must still traverse and read it (no secrets live here).
sudo -n chmod -R a+rX "$APP_DIR"

# STEP 5 -- ACTIVATE.
# shellcheck disable=SC2086
sudo -n systemctl enable -q $UNITS 2>/dev/null || true
# shellcheck disable=SC2086
sudo -n systemctl restart $UNITS
# Lesson: services report "activating" for a few seconds; is-active is non-zero
# then and set -e would abort a good deploy.
STATE=""
for _ in $(seq 1 12); do
  # shellcheck disable=SC2086
  STATE="$(systemctl is-active $UNITS | tr '\n' ' ')"
  case "$STATE" in *activating*) sleep 5;; *) break;; esac
done
echo "[$ENV_NAME] services: $STATE"
case "$STATE" in *inactive*|*failed*)
  echo "DEPLOY FAILED: a service did not come up. Roll back with the previous SHA ($PREVIOUS)."
  # shellcheck disable=SC2086
  for u in $UNITS; do sudo -n journalctl -u "$u" -n 5 --no-pager -o cat | sed "s/^/  [$u] /"; done
  exit 1;;
esac

# STEP 6 -- HEALTH, on the REAL loopback ports of this environment, never a
# neighbour's.
FAILED=0
for probe in "account $ACCOUNT_PORT" "gateway $GATEWAY_PORT" "media-ingest $INGEST_PORT"; do
  set -- $probe
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$2/health" || true)"
  echo "[$ENV_NAME] $1 :$2/health $CODE"
  [ "$CODE" = "200" ] || FAILED=1
done
[ "$FAILED" -eq 0 ] || { echo "DEPLOY FAILED: a health probe did not return 200"; exit 1; }

# STEP 7 -- RUNNING RELEASE == REQUESTED, else FAIL.
#
# TWO halves, because the tree alone cannot say it. `git rev-parse HEAD` proves
# what is ON DISK; a service that failed to restart, or that systemd left alone
# because the unit file did not change, would still be executing the PREVIOUS
# release from a tree that reads correct. So each unit's main process must also
# have started AFTER the checkout. That is the path by which a deploy could
# otherwise report success while the old release serves traffic.
RUNNING="$(git rev-parse HEAD)"
if [ "$RUNNING" != "$SHA" ]; then echo "DEPLOY FAILED: running tree is $RUNNING, expected $SHA"; exit 1; fi
STALE=0
for u in $UNITS; do
  TS="$(systemctl show -p ExecMainStartTimestamp --value "$u" 2>/dev/null || true)"
  if [ -z "$TS" ]; then echo "DEPLOY FAILED: cannot read ExecMainStartTimestamp for $u"; exit 1; fi
  STARTED="$(date -d "$TS" +%s 2>/dev/null || echo 0)"
  if [ "$STARTED" -lt "$CHECKOUT_EPOCH" ]; then
    echo "DEPLOY FAILED: $u has been running since $TS, BEFORE this release was checked out."
    echo "  It is still executing the previous code. Restart it and re-run."
    STALE=1
  fi
done
[ "$STALE" -eq 0 ] || exit 1
echo "[$ENV_NAME] running release $RUNNING (verified: tree and every process started after checkout)"

printf '%s %s previous=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUNNING" "$PREVIOUS" >> "$ROOT/releases.log" 2>/dev/null || true
rm -f "$BUNDLE"
echo "[$ENV_NAME] release $RUNNING verified on the box"
REMOTE

# STEP 8 -- SMOKE, from outside, through Cloudflare and Caddy. The deploy is
# not finished until the public routes answer: a service can be healthy on
# loopback while the edge serves a stale shell or refuses a route.
if [ "${DEPLOY_SKIP_SMOKE:-0}" = "1" ]; then
  echo "[$VIDEOFY_ENV] smoke SKIPPED by DEPLOY_SKIP_SMOKE=1 -- this deploy is not provenance-complete"
  echo "[$VIDEOFY_ENV] DEPLOYED $SHA (unsmoked)"
  exit 0
fi
if ! bash "$HERE/production/smoke.sh" "$VIDEOFY_ENV"; then
  echo "DEPLOY FAILED: $SHA is installed and healthy on the box but the public smoke failed."
  echo "  Roll back with the previous SHA from $VIDEOFY_ROOT/releases.log, or fix the edge."
  exit 1
fi
echo "[$VIDEOFY_ENV] DEPLOYED $SHA"

