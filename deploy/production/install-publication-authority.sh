#!/usr/bin/env bash
# @author masterzee001
#
# Install the publication authority, and NOTHING ELSE.
#
# WHY THIS IS SEPARATE FROM install.sh. A host that is missing publication
# authority is, in every case that matters, a host that is otherwise CONVERGED
# and SERVING. Sending its operator to the full production installer to fix one
# missing symlink helper is remediation that costs more than the fault: that
# script also writes systemd units for the legacy /app layout, and can touch
# coturn and Caddy -- shared with staging, and a restart of either drops live
# relays or live requests. Nobody should have to reinstall production to gain
# one capability.
#
# So this does the five things publication authority consists of, and refuses
# to be anything else. It does not write a unit, does not daemon-reload, does
# not restart, does not touch Caddy, coturn, the environment files, the
# database, app, www, the pointer, or Replay, and it does not widen or narrow
# any sudo grant that already exists.
#
#   sudo bash deploy/production/install-publication-authority.sh
#
# Idempotent: re-running it re-installs the same bytes and re-proves the same
# facts. Running it on a host that already has publication authority is a
# verification, not a change.
#
# TESTABILITY. VIDEOFY_INSTALL_PREFIX relocates every destination under a
# directory, which is how the installation boundary is proven behaviourally --
# that the units are untouched and nothing is restarted is a claim about what
# this script DOES, and a claim like that has to be executed to be believed.
# Root is required when the prefix is empty, which is the only case that can
# affect a real host.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PREFIX="${VIDEOFY_INSTALL_PREFIX:-}"
DEPLOY_OWNER="${DEPLOY_OWNER:-${SUDO_USER:-root}}"

LIB_DIR="$PREFIX/usr/local/lib/videofy"
SBIN_PATH="$PREFIX/usr/local/sbin/videofy-publish-current"
SUDOERS_PATH="$PREFIX/etc/sudoers.d/videofy-publish"
# The sudoers entry always authorises the REAL path, because that is the path a
# deployment will invoke. Under a prefix the two differ, and that is the one
# thing a rehearsal cannot rehearse.
SUDOERS_CMD='/usr/local/sbin/videofy-publish-current'

die() { echo "REFUSED: $*" >&2; exit 1; }

if [ -z "$PREFIX" ]; then
  [ "$(id -u)" -eq 0 ] || die 'run with sudo: sudo bash deploy/production/install-publication-authority.sh'
  # Root-owned, and owned by root specifically -- see the ownership proof below.
  OWNER='root'
  INSTALL_OWNER=(-o root -g root)
else
  # A rehearsal cannot chown to root, so the invariant it proves is the real
  # one in the form available to it: the files belong to the identity that must
  # be their only writer.
  OWNER="$(id -un)"
  INSTALL_OWNER=()
fi

# --- 1 + 2. the verification libraries and the program itself ----------------
#
# ROOT-OWNED COPIES, deliberately. The helper must never source the
# deployment's own shipped libraries: those live under /tmp and belong to the
# deploy identity, so sourcing them would turn a narrow root-owned helper into
# a way to run arbitrary code as root.
install -d "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m 0755 "$LIB_DIR"
install -d "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m 0755 "$(dirname "$SBIN_PATH")"
install "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m 0644 "$HERE/../lib/release-paths.sh"  "$LIB_DIR/release-paths.sh"
install "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m 0644 "$HERE/../lib/release-engine.sh" "$LIB_DIR/release-engine.sh"
install "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m 0755 "$HERE/publish-current.sh"       "$SBIN_PATH"

# --- 3. the sudoers entry ----------------------------------------------------
#
# VALIDATED BEFORE IT IS ANYWHERE sudo WILL READ IT. A malformed file in
# /etc/sudoers.d locks everybody out of sudo -- and so does a well-formed one
# caught half-written, because sudo reads that directory on every invocation.
# So it is composed elsewhere, checked, and installed in one step.
#
# It GRANTS one command to one account. It does not remove or narrow any
# broader grant the account already holds; narrowing that is a separate,
# deliberate change with its own dry-run.
install -d "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m 0755 "$(dirname "$SUDOERS_PATH")"
SUDOERS_TMP="$(mktemp)"
cat > "$SUDOERS_TMP" <<SUDOERS
# Publishing a release is the only privileged step in a deployment.
# Installed by deploy/production/install-publication-authority.sh
$DEPLOY_OWNER ALL=(root) NOPASSWD: $SUDOERS_CMD
SUDOERS
if ! visudo -c -f "$SUDOERS_TMP" >/dev/null; then
  rm -f "$SUDOERS_TMP"
  die 'the generated sudoers entry did not validate; nothing was installed'
fi
install "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m 0440 "$SUDOERS_TMP" "$SUDOERS_PATH"
rm -f "$SUDOERS_TMP"

# --- 4. prove what was installed, rather than assume it ----------------------
#
# `install` can succeed and still leave the wrong thing in place: a pre-existing
# file with a stickier mode, a directory somebody widened by hand. The point of
# this capability is that only root can rewrite the code that runs as root, so
# that is checked rather than trusted.
verify_file() {
  local path="$1" want_mode="$2" owner mode
  [ -f "$path" ] || die "$path was not installed"
  owner="$(stat -c '%U' "$path")"
  [ "$owner" = "$OWNER" ] || die "$path is owned by $owner, not $OWNER"
  mode="$(stat -c '%a' "$path")"
  # Compared as a NUMBER: `stat -c %a` prints 644 where the install was told
  # 0644, and a string comparison calls a correctly installed file wrong.
  [ $(( 0$mode )) -eq $(( 0$want_mode )) ] || die "$path has mode $mode, expected $want_mode"
  # As BITS, not a digit pattern: matching a mode string against *[2367] only
  # inspects its LAST character, so 0775 -- group-writable by exactly the
  # account this guards against -- would pass.
  [ $(( 0$mode & 0022 )) -eq 0 ] || die "$path is group- or world-writable ($mode)"
}
verify_file "$LIB_DIR/release-paths.sh"  0644
verify_file "$LIB_DIR/release-engine.sh" 0644
verify_file "$SBIN_PATH"                 0755
verify_file "$SUDOERS_PATH"              0440

# --- 5. prove the deploy identity can actually use it ------------------------
#
# An installed helper the deploy account may not invoke is the same outage,
# discovered later and further along. `-n` never prompts: an installer that
# stops for a password hangs in automation instead of failing.
if [ -z "$PREFIX" ]; then
  if [ "$DEPLOY_OWNER" != 'root' ]; then
    # As the account that will actually do it, not as root -- root can invoke
    # it whatever sudoers says, so proving it from here would prove nothing.
    CHECK_AS=(sudo -n -u "$DEPLOY_OWNER" sudo -n "$SBIN_PATH" --check)
  else
    CHECK_AS=(sudo -n "$SBIN_PATH" --check)
  fi
else
  # Under a prefix the helper's compiled-in library path is not where these
  # were just installed, so it is pointed at the copies this run produced --
  # otherwise the check would pass or fail on the real host's state, which is
  # the one thing a rehearsal must never consult.
  CHECK_AS=(env "VIDEOFY_PUBLISH_LIB=$LIB_DIR" sudo -n "$SBIN_PATH" --check)
fi
if ! "${CHECK_AS[@]}" >/dev/null 2>&1; then
  die "$SBIN_PATH is installed but $DEPLOY_OWNER cannot invoke it under sudo"
fi

echo "publication authority installed and proven:"
echo "  $SBIN_PATH"
echo "  $LIB_DIR/{release-paths,release-engine}.sh"
echo "  $SUDOERS_PATH  ($DEPLOY_OWNER -> $SUDOERS_CMD)"
echo "no unit was written, nothing was reloaded, and nothing was restarted."
