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
# So this does the things publication authority consists of, and refuses to be
# anything else. It does not write a unit, does not daemon-reload, does not
# restart, does not touch Caddy, coturn, the environment files, the database,
# app, www, the pointer, or Replay, and it does not widen or narrow any sudo
# grant that already exists.
#
#   sudo bash deploy/production/install-publication-authority.sh
#
# Idempotent: re-running it re-installs the same bytes and re-proves the same
# facts. Running it on a host that already has publication authority is a
# verification, not a change.
#
# EVERY REPLACEMENT IS A RENAME. This runs on a live host, against files that
# other processes read at unpredictable moments: sudo reads /etc/sudoers.d on
# every single invocation, and a publication in flight is reading the helper
# and the libraries it sources. `install` and `cp` open the destination and
# write through it, so for as long as that takes, a reader sees a file that is
# neither the old one nor the new one. For a sudoers file that is a window in
# which nobody on the box can use sudo; for the helper it is a window in which
# a publisher executes half a program.
#
# rename(2) has no such window. Each file is staged beside its destination, on
# the same filesystem, given its final ownership and mode, verified, and only
# then renamed over the top. A reader holding the old file open keeps reading
# the old file, complete, until it closes.
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
SBIN_DIR="$PREFIX/usr/local/sbin"
SBIN_PATH="$SBIN_DIR/videofy-publish-current"
SUDOERS_DIR="$PREFIX/etc/sudoers.d"
SUDOERS_PATH="$SUDOERS_DIR/videofy-publish"
# The sudoers entry always authorises the REAL path, because that is the path a
# deployment will invoke. Under a prefix the two differ, and that is the one
# thing a rehearsal cannot rehearse.
SUDOERS_CMD='/usr/local/sbin/videofy-publish-current'

die() { echo "REFUSED: $*" >&2; exit 1; }

# THE ATOMIC STEP, on one line so that a mutation can replace it wholesale and
# the suite can prove the difference is visible.
atomic_place() { mv -Tf "$1" "$2"; }

# A staging name in the DESTINATION DIRECTORY -- rename(2) cannot cross a
# filesystem, so staging in /tmp and moving would be a copy again.
#
# The leading dot matters in /etc/sudoers.d: sudo's includedir skips any file
# whose name contains a `.` or ends in `~`, so a staged entry is never read as
# configuration while it waits. The final name deliberately has no dot.
staged_name() { printf '%s/.%s.staging.%s' "$(dirname "$1")" "$(basename "$1")" "$$"; }

STAGED_FILES=()
cleanup() { local f; for f in ${STAGED_FILES[@]+"${STAGED_FILES[@]}"}; do rm -f "$f"; done; }
trap cleanup EXIT

if [ -z "$PREFIX" ]; then
  [ "$(id -u)" -eq 0 ] || die 'run with sudo: sudo bash deploy/production/install-publication-authority.sh'
  OWNER='root'
  INSTALL_OWNER=(-o root -g root)
else
  # A rehearsal cannot chown to root, so the invariant it proves is the real
  # one in the form available to it: the files belong to the identity that must
  # be their only writer.
  OWNER="$(id -un)"
  INSTALL_OWNER=()
fi

# Stage a file beside where it will live, with its final ownership and mode.
# Nothing is replaced here -- this only creates the candidate.
#
# The path is returned in STAGED rather than printed, because a command
# substitution runs in a subshell and the record of what to clean up would die
# with it -- leaving staged files behind on a failure, which is the one moment
# they matter.
STAGED=''
stage() {
  local src="$1" final="$2" mode="$3"
  STAGED="$(staged_name "$final")"
  STAGED_FILES+=("$STAGED")
  install "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m "$mode" "$src" "$STAGED"
}

# Create a directory only if it is absent. /etc/sudoers.d already exists on a
# real host, sometimes at 0750, and re-installing it would change a mode this
# script has no business changing.
ensure_dir() {
  [ -d "$1" ] || install -d "${INSTALL_OWNER[@]+"${INSTALL_OWNER[@]}"}" -m 0755 "$1"
}

# --- the sudoers entry, PREPARED AND VALIDATED FIRST -------------------------
#
# Ordered before anything is installed so that the one failure an operator is
# most likely to hit -- a sudoers entry that does not parse -- can be reported
# with the words "nothing was installed" and have them be literally true.
ensure_dir "$SUDOERS_DIR"
SUDOERS_TEXT="$(mktemp)"
STAGED_FILES+=("$SUDOERS_TEXT")
cat > "$SUDOERS_TEXT" <<SUDOERS
# Publishing a release is the only privileged step in a deployment.
# Installed by deploy/production/install-publication-authority.sh
$DEPLOY_OWNER ALL=(root) NOPASSWD: $SUDOERS_CMD
SUDOERS
stage "$SUDOERS_TEXT" "$SUDOERS_PATH" 0440; SUDOERS_STAGED="$STAGED"
if ! visudo -c -f "$SUDOERS_STAGED" >/dev/null 2>&1; then
  die "the generated sudoers entry does not parse; nothing was installed and $SUDOERS_PATH is unchanged"
fi

# --- the verification libraries and the program itself -----------------------
#
# ROOT-OWNED COPIES, deliberately. The helper must never source the
# deployment's own shipped libraries: those live under /tmp and belong to the
# deploy identity, so sourcing them would turn a narrow root-owned helper into
# a way to run arbitrary code as root.
ensure_dir "$LIB_DIR"
ensure_dir "$SBIN_DIR"
stage "$HERE/../lib/release-paths.sh"  "$LIB_DIR/release-paths.sh"  0644; PATHS_STAGED="$STAGED"
stage "$HERE/../lib/release-engine.sh" "$LIB_DIR/release-engine.sh" 0644; ENGINE_STAGED="$STAGED"
stage "$HERE/publish-current.sh"       "$SBIN_PATH"                 0755; SBIN_STAGED="$STAGED"

# Everything is staged and the sudoers text parses. From here each replacement
# is a single rename, so a concurrent reader of any of these files sees the
# complete old one or the complete new one.
atomic_place "$PATHS_STAGED"  "$LIB_DIR/release-paths.sh"
atomic_place "$ENGINE_STAGED" "$LIB_DIR/release-engine.sh"
atomic_place "$SBIN_STAGED"   "$SBIN_PATH"

# The sudoers entry last, because it is what makes the rest reachable: until it
# lands, the deploy account simply cannot invoke a helper that may be mid-swap.
SUDOERS_PREV=''
if [ -f "$SUDOERS_PATH" ]; then
  # Kept under a dotted name so sudo will not read it, and restored by rename
  # rather than by copying it back.
  SUDOERS_PREV="$SUDOERS_DIR/.videofy-publish.previous.$$"
  STAGED_FILES+=("$SUDOERS_PREV")
  cp -p "$SUDOERS_PATH" "$SUDOERS_PREV"
fi
atomic_place "$SUDOERS_STAGED" "$SUDOERS_PATH"

# THE WHOLE CONFIGURATION, not just the file this wrote.
#
# A file that parses alone can still be rejected in combination, and the cost
# of being wrong is that nobody on the box can use sudo. So the global check
# runs after the rename and, if it fails, the previous state is put back the
# same way it was replaced.
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
  # Under a prefix the real /etc/sudoers is not the configuration under test,
  # and validating it would report on the host instead of the rehearsal.
  if ! visudo -c -f "$SUDOERS_PATH" >/dev/null 2>&1; then
    sudoers_restore
    die "the installed sudoers entry did not validate; $SUDOERS_PATH was restored"
  fi
fi
rm -f "$SUDOERS_PREV"

# --- prove what was installed, rather than assume it -------------------------
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

# --- prove the deploy identity can actually use it ---------------------------
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
  die "$SBIN_PATH and $SUDOERS_PATH are installed, but $DEPLOY_OWNER cannot invoke the helper under sudo"
fi

echo "publication authority installed and proven:"
echo "  $SBIN_PATH"
echo "  $LIB_DIR/{release-paths,release-engine}.sh"
echo "  $SUDOERS_PATH  ($DEPLOY_OWNER -> $SUDOERS_CMD)"
echo "every replacement was a rename; no unit was written, nothing was reloaded,"
echo "and nothing was restarted."
