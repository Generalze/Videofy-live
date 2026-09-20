#!/usr/bin/env bash
# @author masterzee001
#
# Install the bounded deployment privileges, and NOTHING ELSE.
#
# WHAT THIS REPLACES. The deploy account on the production host holds
#
#     claude ALL=(ALL) NOPASSWD: ALL
#
# which is root, spelled at length. Removing it needs the privileges an
# ordinary atomic deployment and rollback ACTUALLY use to exist first, and
# there are exactly three:
#
#   1. move the release pointer      videofy-publish-current      (already installed)
#   2. restart the three services    systemctl restart <unit>     (named, not wildcarded)
#   3. evaluate the candidate's      videofy-production-preflight (as videofy, not root)
#      startup configuration
#
# Nothing else. Not `systemctl enable`, which is provisioning; not
# `daemon-reload`, which belongs to unit work; not chown, chmod, Caddy, coturn,
# database administration, or a shell.
#
#   sudo bash deploy/production/install-sudo-hardening.sh
#
# THIS SCRIPT DOES NOT REMOVE THE BROAD GRANT. It installs the narrow rules
# beside it so both are in force, which is the only safe order: the narrow
# policy has to be provable on the host before anything is taken away, with a
# root session open. Removal is a separate, deliberate act.
#
# Idempotent, and every replacement is a rename -- staged beside its
# destination on the same filesystem, given its final ownership and mode,
# validated, and only then renamed over the top. `install` and `cp` write
# through the destination, and sudo reads /etc/sudoers.d on every invocation:
# a half-written file there is a window in which nobody on the box can use
# sudo at all.
#
# TESTABILITY. VIDEOFY_INSTALL_PREFIX relocates every destination under a
# directory. Root is required whenever the prefix is empty, which is the only
# case that can affect a real host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PREFIX="${VIDEOFY_INSTALL_PREFIX:-}"
DEPLOY_OWNER="${DEPLOY_OWNER:-${SUDO_USER:-root}}"
SERVICE_USER="${VIDEOFY_SERVICE_USER:-videofy}"

LIB_DIR="$PREFIX/usr/local/lib/videofy"
SBIN_DIR="$PREFIX/usr/local/sbin"
PREFLIGHT_PATH="$SBIN_DIR/videofy-production-preflight"
SUDOERS_DIR="$PREFIX/etc/sudoers.d"
SUDOERS_PATH="$SUDOERS_DIR/videofy-deploy"

# The rules authorise the REAL paths, because those are what a deployment will
# invoke. Under a prefix the two differ, and that is the one thing a rehearsal
# cannot rehearse.
readonly REAL_PUBLISH='/usr/local/sbin/videofy-publish-current'
readonly REAL_PREFLIGHT='/usr/local/sbin/videofy-production-preflight'
readonly SYSTEMCTL='/usr/bin/systemctl'
UNITS="${VIDEOFY_UNITS:-videofy-prod-account videofy-prod-gateway videofy-prod-media-ingest}"

die() { echo "REFUSED: $*" >&2; exit 1; }

atomic_place() { mv -Tf "$1" "$2"; }
staged_name() { printf '%s/.%s.staging.%s' "$(dirname "$1")" "$(basename "$1")" "$$"; }

STAGED_FILES=()
cleanup() { local f; for f in ${STAGED_FILES[@]+"${STAGED_FILES[@]}"}; do rm -f "$f"; done; }
trap cleanup EXIT

if [ -z "$PREFIX" ]; then
  [ "$(id -u)" -eq 0 ] || die 'run with sudo: sudo bash deploy/production/install-sudo-hardening.sh'
  OWNER='root'
  INSTALL_OWNER=(-o root -g root)
else
  OWNER="$(id -un)"
  INSTALL_OWNER=()
fi

STAGED=''
stage() {
  local src="$1" final="$2" mode="$3"
  STAGED="$(staged_name "$final")"
  STAGED_FILES+=("$STAGED")
  install "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m "$mode" "$src" "$STAGED"
}
ensure_dir() {
  [ -d "$1" ] || install -d "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m 0755 "$1"
}

# --- the sudoers rules, PREPARED AND VALIDATED FIRST -------------------------
#
# Ordered before anything is placed so that a refusal saying "nothing was
# installed" is literally true.
#
# EACH SERVICE IS NAMED. `systemctl restart videofy-prod-*` would look tidier
# and would authorise restarting anything that ever gets that prefix, including
# units this deployment has no business touching. There are three; they are
# written out.
#
# The preflight rule specifies no arguments, deliberately. A sudoers wildcard is
# a pattern match on a string the caller supplies: it cannot canonicalise, it
# cannot follow a symlink, and it cannot tell `/srv/videofy-prod/releases-x`
# from `/srv/videofy-prod/releases`. The candidate contract is enforced inside
# the helper, where those questions can actually be asked.
ensure_dir "$SUDOERS_DIR"
SUDOERS_TEXT="$(mktemp)"
STAGED_FILES+=("$SUDOERS_TEXT")
{
  echo '# The complete set of privileges an atomic deployment and rollback use.'
  echo '# Installed by deploy/production/install-sudo-hardening.sh'
  echo '#'
  echo '# Deliberately absent: systemctl enable (provisioning), daemon-reload'
  echo '# (unit work), unit installation, chown, chmod, Caddy, coturn, database'
  echo '# administration, a shell, and any generic interpreter.'
  echo ''
  printf 'Cmnd_Alias VIDEOFY_PUBLISH = %s\n' "$REAL_PUBLISH"
  # Built on ONE line. A sudoers alias can be continued with a trailing
  # backslash, but a backslash-newline emitted from a shell script is the kind
  # of generated escaping that renders as a literal `\n` when somebody edits
  # the printf later -- and the file it would corrupt is the one that decides
  # whether anybody can use sudo. Length costs nothing.
  activate=''
  for unit in $UNITS; do
    [ -z "$activate" ] || activate="$activate, "
    activate="$activate$SYSTEMCTL restart $unit"
  done
  printf 'Cmnd_Alias VIDEOFY_ACTIVATE = %s\n' "$activate"
  printf 'Cmnd_Alias VIDEOFY_PREFLIGHT = %s\n' "$REAL_PREFLIGHT"
  echo ''
  printf '%s ALL=(root) NOPASSWD: VIDEOFY_PUBLISH, VIDEOFY_ACTIVATE\n' "$DEPLOY_OWNER"
  printf '%s ALL=(%s) NOPASSWD: VIDEOFY_PREFLIGHT\n' "$DEPLOY_OWNER" "$SERVICE_USER"
} > "$SUDOERS_TEXT"

stage "$SUDOERS_TEXT" "$SUDOERS_PATH" 0440; SUDOERS_STAGED="$STAGED"
if ! visudo -c -f "$SUDOERS_STAGED" >/dev/null 2>&1; then
  echo "the generated rules were:" >&2
  sed 's/^/    /' "$SUDOERS_TEXT" >&2
  die "the generated sudoers rules do not parse; nothing was installed and $SUDOERS_PATH is unchanged"
fi

# --- the preflight program and its implementation ----------------------------
#
# ROOT-OWNED COPIES. The implementation must never be the deployment's own
# shipped copy: those live under /tmp and belong to the deploy account, so
# running one as the service user would be exactly the arbitrary-execution hole
# this package exists to close.
ensure_dir "$LIB_DIR"
ensure_dir "$SBIN_DIR"
stage "$HERE/production-preflight.sh" "$PREFLIGHT_PATH"             0755; PRE_STAGED="$STAGED"
stage "$HERE/../lib/preflight-config.mjs" "$LIB_DIR/preflight-config.mjs" 0644; IMPL_STAGED="$STAGED"

atomic_place "$PRE_STAGED"  "$PREFLIGHT_PATH"
atomic_place "$IMPL_STAGED" "$LIB_DIR/preflight-config.mjs"

# The rules last: until they land, nothing can invoke a program that may be
# mid-swap.
SUDOERS_PREV=''
if [ -f "$SUDOERS_PATH" ]; then
  SUDOERS_PREV="$SUDOERS_DIR/.videofy-deploy.previous.$$"
  STAGED_FILES+=("$SUDOERS_PREV")
  cp -p "$SUDOERS_PATH" "$SUDOERS_PREV"
fi
atomic_place "$SUDOERS_STAGED" "$SUDOERS_PATH"

# THE WHOLE CONFIGURATION, not just the file this wrote. A file that parses
# alone can still be rejected in combination, and the cost of being wrong is
# that nobody on the box can use sudo.
sudoers_restore() {
  if [ -n "$SUDOERS_PREV" ] && [ -f "$SUDOERS_PREV" ]; then
    atomic_place "$SUDOERS_PREV" "$SUDOERS_PATH"
  else
    rm -f "$SUDOERS_PATH"
  fi
}
if [ -z "$PREFIX" ]; then
  if ! visudo -c >/dev/null 2>&1; then
    sudoers_restore
    die "the sudo configuration as a whole did not validate; $SUDOERS_PATH was restored"
  fi
else
  if ! visudo -c -f "$SUDOERS_PATH" >/dev/null 2>&1; then
    sudoers_restore
    die "the installed rules did not validate; $SUDOERS_PATH was restored"
  fi
fi
rm -f "$SUDOERS_PREV"

# --- prove what was installed, rather than assume it -------------------------
verify_file() {
  local path="$1" want_mode="$2" owner mode
  [ -f "$path" ] || die "$path was not installed"
  owner="$(stat -c '%U' "$path")"
  [ "$owner" = "$OWNER" ] || die "$path is owned by $owner, not $OWNER"
  mode="$(stat -c '%a' "$path")"
  [ $(( 0$mode )) -eq $(( 0$want_mode )) ] || die "$path has mode $mode, expected $want_mode"
  [ $(( 0$mode & 0022 )) -eq 0 ] || die "$path is group- or world-writable ($mode)"
}
verify_file "$PREFLIGHT_PATH"             0755
verify_file "$LIB_DIR/preflight-config.mjs" 0644
verify_file "$SUDOERS_PATH"               0440

# --- prove the deploy identity can actually use it ---------------------------
if [ -z "$PREFIX" ] && [ "$DEPLOY_OWNER" != 'root' ]; then
  if ! sudo -n -u "$DEPLOY_OWNER" sudo -n -u "$SERVICE_USER" "$PREFLIGHT_PATH" --check >/dev/null 2>&1; then
    die "$PREFLIGHT_PATH is installed but $DEPLOY_OWNER cannot invoke it as $SERVICE_USER"
  fi
fi

echo "bounded deployment privileges installed:"
echo "  $PREFLIGHT_PATH   (run as $SERVICE_USER)"
echo "  $LIB_DIR/preflight-config.mjs"
echo "  $SUDOERS_PATH"
echo
echo "the deploy identity '$DEPLOY_OWNER' is now granted, and granted only:"
echo "  (root)     $REAL_PUBLISH"
for unit in $UNITS; do echo "  (root)     $SYSTEMCTL restart $unit"; done
echo "  ($SERVICE_USER)  $REAL_PREFLIGHT"
echo
echo "NOT removed by this script: any broader grant that already exists."
echo "Prove the above on the host, with a root session open, before removing it."
