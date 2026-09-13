#!/usr/bin/env bash
# @author masterzee001
#
# Record the completed deployment, and nothing else.
#
# This is the finalisation twin of videofy-publish-current. Production keeps
# /srv/videofy-prod root-owned, so the deploy identity cannot create or replace
# files beside current, releases, uploads or environment material. That is the
# point. The deploy still needs exactly one post-smoke write there:
# DEPLOY-STATE.md.
#
#   videofy-record-deploy-state <active-sha> <previous-sha|none|rolled-back>
#   videofy-record-deploy-state --reconcile <active-sha> <previous-sha|none|rolled-back> <YYYY-MM-DDTHH:MM:SSZ>
#   videofy-record-deploy-state --check
#
# The active release is a SHA, not a path. The helper verifies that current
# already names that SHA, the release is sealed and intact, and then atomically
# replaces only /srv/videofy-prod/DEPLOY-STATE.md.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  ROOT='/srv/videofy-prod'
  LIB='/usr/local/lib/videofy'
  ENV_NAME='production'
else
  ROOT="${VIDEOFY_RECORD_ROOT:-/srv/videofy-prod}"
  LIB="${VIDEOFY_RECORD_LIB:-/usr/local/lib/videofy}"
  ENV_NAME="${VIDEOFY_RECORD_ENV:-production}"
fi
readonly ROOT
readonly LIB
readonly ENV_NAME
readonly CURRENT="$ROOT/current"
readonly RELEASES="$ROOT/releases"
readonly WWW="$ROOT/www"
readonly STATE_FILE="$ROOT/DEPLOY-STATE.md"

die() { echo "REFUSED: $*" >&2; exit 1; }

strict_utc_timestamp() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  [ "$(date -u -d "$value" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" = "$value" ]
}

for module in release-paths.sh release-engine.sh; do
  file="$LIB/$module"
  [ -f "$file" ] || die "$file is missing; run deploy/production/install-publication-authority.sh"
  if [ "$(id -u)" -eq 0 ]; then
    owner="$(stat -c '%U' "$file")"
    [ "$owner" = 'root' ] || die "$file is owned by $owner, not root"
    mode="$(stat -c '%a' "$file")"
    [ -n "$mode" ] || die "$file has no readable mode"
    [ $(( 0$mode & 0022 )) -eq 0 ] || die "$file is group- or world-writable ($mode)"
  fi
done
# shellcheck source=/dev/null
. "$LIB/release-paths.sh"
# shellcheck source=/dev/null
. "$LIB/release-engine.sh"

MODE='finalize'
case "${1-}" in
  --check)
    echo 'deployment state recording authority available'
    exit 0
    ;;
  --reconcile)
    MODE='reconcile'
    shift
    [ "$#" -eq 3 ] || die 'usage: videofy-record-deploy-state --reconcile <active-sha> <previous-sha|none|rolled-back> <YYYY-MM-DDTHH:MM:SSZ>'
    ;;
  '')
    die 'usage: videofy-record-deploy-state <active-sha> <previous-sha|none|rolled-back> | videofy-record-deploy-state --reconcile <active-sha> <previous-sha|none|rolled-back> <YYYY-MM-DDTHH:MM:SSZ> | --check'
    ;;
esac

[ "$MODE" = 'reconcile' ] || [ "$#" -eq 2 ] || die 'exactly two arguments are accepted'
SHA="$1"
PREVIOUS="$2"
if [ "$MODE" = 'reconcile' ]; then
  CUTOVER_UTC="$3"
  strict_utc_timestamp "$CUTOVER_UTC" || die 'reconciliation cutover timestamp is not strict UTC YYYY-MM-DDTHH:MM:SSZ'
else
  CUTOVER_UTC=''
fi

assert_full_sha 'active release sha' "$SHA" || exit 1
case "$PREVIOUS" in
  none|rolled-back) ;;
  *) assert_full_sha 'previous release sha' "$PREVIOUS" || exit 1 ;;
esac

TARGET="$RELEASES/$SHA"
RESOLVED="$(readlink -m -- "$TARGET")"
case "$RESOLVED/" in
  "$RELEASES"/*) ;;
  *) die "$TARGET resolves to $RESOLVED, outside $RELEASES" ;;
esac
[ -d "$TARGET" ] || die "$TARGET does not exist"

LIVE="$(pointer_sha "$CURRENT" "$RELEASES")"
[ "$LIVE" = "$SHA" ] || die "$CURRENT names $LIVE, not $SHA"

release_is_complete "$TARGET" || die "$TARGET is not a sealed, intact release"
[ "$(release_recorded_sha "$TARGET")" = "$SHA" ] || die "$TARGET/RELEASE.json does not name $SHA"
release_symlinks_stay_inside "$TARGET" >/dev/null 2>&1 || die "$TARGET contains a symlink that escapes it"

if [ "$MODE" = 'reconcile' ]; then
  RECORDED_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
else
  CUTOVER_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  RECORDED_UTC=''
fi

TMP="$STATE_FILE.tmp.$$"
trap 'rm -f "$TMP"' EXIT
umask 022
{
  printf '# Deployment state\n\n'
  printf 'Written by the deploy. The pointer below is the authority; a git\n'
  printf 'checkout under this root is not.\n\n'
  if [ "$MODE" = 'reconcile' ]; then
    printf 'This file was written as a historical reconciliation. The cutover\n'
    printf 'timestamp below is the original observed cutover, not the file write time.\n\n'
  fi
  printf '| | |\n|---|---|\n'
  printf '| active | `%s` |\n' "$SHA"
  printf '| previous | `%s` |\n' "$PREVIOUS"
  printf '| release path | `%s/%s` |\n' "$RELEASES" "$SHA"
  printf '| cutover (UTC) | %s |\n' "$CUTOVER_UTC"
  if [ "$MODE" = 'reconcile' ]; then
    printf '| reconciliation recorded (UTC) | %s |\n' "$RECORDED_UTC"
  fi
  printf '\n## Rolling back\n\n'
  printf 'The previous release is still sealed on disk, so no rebuild is\n'
  printf 'needed. The command performs the WHOLE transition -- pointer,\n'
  printf 'restart, health, running-release proof and public smoke -- rather\n'
  printf 'than moving a pointer and leaving you to finish it:\n\n'
  printf '```\nbash deploy/atomic-deploy.sh %s rollback <sha>\n```\n\n' "$ENV_NAME"
  printf '## Pointers\n\n```\n'
  release_state "$RELEASES" "$CURRENT" "$WWW"
  printf '```\n'
} > "$TMP"
chmod 0644 "$TMP"
mv -Tf "$TMP" "$STATE_FILE"
trap - EXIT

echo "recorded: $STATE_FILE -> $SHA"
