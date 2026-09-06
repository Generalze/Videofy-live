#!/usr/bin/env bash
# @author masterzee001
#
# The one privileged thing a deployment needs, and nothing else.
#
# WHY THIS EXISTS. `/srv/videofy-prod` is root-owned, correctly: the deploy
# identity has no business creating files beside the live release store, the
# uploads directory or the environment files. But publishing a release means
# replacing `/srv/videofy-prod/current`, and replacing a symlink requires write
# permission on the DIRECTORY that contains it.
#
# During the 2026-09-06 convergence that gap was closed by hand, with sudo.
# That is exactly the kind of undocumented requirement that works once and then
# fails at 3am for somebody who does not know it exists.
#
# THE ALTERNATIVES WERE WORSE. Making the root writable by the deploy group
# hands it the ability to rename `app`, `state`, `uploads` and the release
# store; relying on the account's existing blanket sudo makes every deployment
# an unaudited root shell. This is the narrowest thing that works: one
# operation, no path arguments, no shell.
#
#   videofy-publish-current <40-char-sha>    publish that release
#   videofy-publish-current --check          prove invocability, change nothing
#
# THE ROOT AND POINTER ARE COMPILED IN. They are not arguments, because an
# argument is a thing a caller can change. The only input is a SHA, and a SHA
# that is not forty lowercase hex characters is refused before it is ever used
# to build a path.
#
# IT SOURCES ONLY ROOT-OWNED CODE. The verification helpers live in
# /usr/local/lib/videofy, installed by install-publication-authority.sh and
# writable only by root.
# Sourcing the deployment's own libraries -- which live in /tmp and belong to
# the deploy user -- would turn this into a way to run arbitrary code as root,
# which is the precise opposite of its purpose.
set -euo pipefail

# THE ONE OVERRIDE, AND WHY IT CANNOT BE USED AGAINST US.
#
# The paths below are compiled in precisely so a caller cannot choose them. But
# a program that can only ever act on the live production root is a program
# that can only be tested against the live production root, and the refusals
# below are the whole point of it existing -- they have to be provable.
#
# So the override is admitted in exactly one circumstance: when this is NOT
# running privileged. Reached the way it is meant to be reached -- `sudo -n
# videofy-publish-current <sha>` -- this process is uid 0 and the override is
# not merely ignored, it is unreachable. (sudo also resets the environment, so
# the variables never arrive in the first place; the uid test is the guarantee
# that does not depend on how sudoers is written.) Anybody who can run this as
# root without sudo is already root and has no need of a symlink helper.
if [ "$(id -u)" -eq 0 ]; then
  ROOT='/srv/videofy-prod'
  LIB='/usr/local/lib/videofy'
else
  ROOT="${VIDEOFY_PUBLISH_ROOT:-/srv/videofy-prod}"
  LIB="${VIDEOFY_PUBLISH_LIB:-/usr/local/lib/videofy}"
fi
readonly ROOT
readonly LIB
readonly POINTER="$ROOT/current"
readonly RELEASES="$ROOT/releases"

die() { echo "REFUSED: $*" >&2; exit 1; }

# Refuse to run at all if the code this depends on could have been written by
# somebody other than root. A privileged helper that trusts a writable library
# is not privileged, it is borrowed.
#
# The ownership demand applies when it means something: running as root. Run
# unprivileged, sourcing a library owned by the invoking user escalates nothing
# -- it is that user's own code, running as that user.
for module in release-paths.sh release-engine.sh; do
  file="$LIB/$module"
  [ -f "$file" ] || die "$file is missing; run deploy/production/install-publication-authority.sh"
  if [ "$(id -u)" -eq 0 ]; then
    owner="$(stat -c '%U' "$file")"
    [ "$owner" = 'root' ] || die "$file is owned by $owner, not root"
    # As BITS, not as a digit pattern: matching the mode string against
    # *[2367] only inspects its LAST character, so 0775 -- group-writable by
    # the very account this guards against -- would pass.
    mode="$(stat -c '%a' "$file")"
    [ -n "$mode" ] || die "$file has no readable mode"
    [ $(( 0$mode & 0022 )) -eq 0 ] || die "$file is group- or world-writable ($mode)"
  fi
done
# shellcheck source=/dev/null
. "$LIB/release-paths.sh"
# shellcheck source=/dev/null
. "$LIB/release-engine.sh"

case "${1-}" in
  --check)
    # Says only "you may call me", touching nothing. The deployment bootstrap
    # uses this to fail early rather than discovering the problem after a
    # release has been built.
    echo 'publication authority available'
    exit 0
    ;;
  '')
    die 'usage: videofy-publish-current <40-char-sha> | --check'
    ;;
esac

[ "$#" -eq 1 ] || die 'exactly one argument is accepted'
SHA="$1"

# A SHA, or nothing. Every path below is built from this, so it is checked
# before it is used rather than after.
assert_full_sha 'release sha' "$SHA" || exit 1

TARGET="$RELEASES/$SHA"

# Belt and braces: the SHA pattern already forbids traversal, but the resolved
# path is checked against the release store anyway. The cost is one syscall and
# the failure it prevents is publishing something outside the store.
RESOLVED="$(readlink -m -- "$TARGET")"
case "$RESOLVED/" in
  "$RELEASES"/*) ;;
  *) die "$TARGET resolves to $RESOLVED, outside $RELEASES" ;;
esac
[ -d "$TARGET" ] || die "$TARGET does not exist"

# THE SAME PROOFS THE DEPLOYMENT ENGINE DEMANDS, applied here as well. This
# runs as root and is reachable by the deploy account, so it cannot assume the
# caller checked anything: a helper that publishes whatever it is handed is a
# privileged way to publish an unqualified release.
release_is_complete "$TARGET" || die "$TARGET is not a sealed, intact release"
[ "$(release_recorded_sha "$TARGET")" = "$SHA" ] || die "$TARGET/RELEASE.json does not name $SHA"
release_symlinks_stay_inside "$TARGET" >/dev/null 2>&1 || die "$TARGET contains a symlink that escapes it"

# The atomic replacement, and the only mutation this program can perform.
TMP="$POINTER.publishing.$$"
ln -sfn "$TARGET" "$TMP"
mv -Tf "$TMP" "$POINTER"

echo "published: $POINTER -> $(readlink "$POINTER")"
