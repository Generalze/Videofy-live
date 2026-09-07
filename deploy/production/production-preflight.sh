#!/usr/bin/env bash
# @author masterzee001
#
# Evaluate a production candidate's startup configuration, AS THE SERVICE USER,
# and do nothing else that could be asked of it.
#
# WHY THIS EXISTS. The preflight has to run as the identity that will really
# boot the service: the environment file is 0640 root:videofy and holds every
# provider key, the deploy account cannot read it, and widening that to make a
# check work would hand the deployment account all of production's secrets
# permanently. Running as root would answer the wrong question -- root can read
# anything, so a pass would prove nothing about the identity that actually
# starts.
#
# So the deploy account needs to run something as `videofy`. What it used to be
# granted was:
#
#     claude ALL=(videofy) NOPASSWD: /usr/bin/node, /usr/bin/test
#
# `node` with an arbitrary script is arbitrary code execution as the service
# user, and the script it ran lived under /tmp, owned by the deploy account. A
# grant like that is not a preflight permission, it is a second identity.
#
# This program replaces both. It is the ONLY thing the deploy account may run
# as `videofy`, it takes ONE argument, and the environment file, the node
# binary and the preflight implementation are compiled in rather than chosen by
# the caller.
#
#   sudo -n -u videofy /usr/local/sbin/videofy-production-preflight <candidate>
#
# WHAT IT DOES EXECUTE AS THE SERVICE USER, stated plainly: the candidate's own
# `config.js`, imported by the installed preflight implementation. That is
# deploy-authored code running as `videofy` -- but it is the same file the
# service itself will execute as `videofy` moments later if the candidate is
# published. This exercises that boundary early; it does not widen it. What the
# containment rules below buy is that it can only ever be a real candidate
# inside the release store, never an arbitrary path the caller names.
set -euo pipefail

# COMPILED IN, because an argument is a thing a caller can choose. The
# environment file in particular: letting the caller name it would turn this
# into "read any file you like, as the user that can read the secrets".
readonly RELEASES='/srv/videofy-prod/releases'
readonly ENV_FILE='/etc/videofy-prod/media-ingest.env'
readonly NODE='/usr/bin/node'
readonly IMPL='/usr/local/lib/videofy/preflight-config.mjs'
# Who the implementation must belong to. A constant rather than a literal in
# the check below so the rule can be exercised against a rig -- the shipped
# value is `root`, and that is the only value a real host ever runs with.
readonly IMPL_OWNER='root'
readonly CONFIG_REL='services/media-ingest/dist/services/media-ingest/src/config.js'

die() { echo "PREFLIGHT REFUSED: $*" >&2; exit 1; }

case "${1-}" in
  --check)
    # Says only "you may call me", touching nothing -- the same contract the
    # publication helper offers, so a host can be proven without a deployment.
    echo 'production preflight authority available'
    exit 0
    ;;
  '')
    die 'usage: videofy-production-preflight <candidate-dir> | --check'
    ;;
esac
[ "$#" -eq 1 ] || die 'exactly one argument is accepted'

CANDIDATE="$1"

# --- the candidate path contract ---------------------------------------------
#
# Enforced HERE rather than in sudoers. A sudoers wildcard is a pattern match on
# a string the caller supplies; it cannot canonicalise, it cannot follow a
# symlink, and it cannot tell `/srv/videofy-prod/releases-scratch` from
# `/srv/videofy-prod/releases`. Every one of those is a way out.

case "$CANDIDATE" in
  /*) ;;
  *) die "candidate must be an absolute path, got '$CANDIDATE'" ;;
esac

# Resolved before it is compared, so a symlink pointing out of the release store
# is judged by where it LANDS and not by how it is spelled. `-m` canonicalises
# without requiring existence, so a path that escapes to something absent is
# still caught rather than skipped.
RESOLVED="$(readlink -m -- "$CANDIDATE")"
[ -n "$RESOLVED" ] || die 'the candidate path could not be resolved'

# THE TRAILING SLASH IS THE POINT. Comparing "$RESOLVED" against "$RELEASES"*
# would accept /srv/videofy-prod/releases-anything: a prefix lookalike is a
# different directory that happens to start with the same characters.
case "$RESOLVED/" in
  "$RELEASES"/*) ;;
  *) die "candidate resolves to $RESOLVED, outside $RELEASES" ;;
esac
[ "$RESOLVED" != "$RELEASES" ] || die 'the release store itself is not a candidate'

# AND IT MUST LOOK LIKE SOMETHING THE ENGINE MAKES. Containment alone would
# admit any stray directory somebody dropped in the store; these are the two
# forms `release_prepare` and `release_publish` actually produce.
BASE="${RESOLVED##*/}"
PARENT="${RESOLVED%/*}"
[ "$PARENT" = "$RELEASES" ] || die "candidate is nested below $RELEASES, not in it"
case "$BASE" in
  # An in-flight candidate: .candidate-<40 hex>.<transaction suffix>
  .candidate-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].?*) ;;
  # A sealed release, which rollback re-checks before returning to it.
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) die "'$BASE' is not a release or an in-flight candidate" ;;
esac

# --- what the real startup needs, proven as the identity that will need it ----
#
# These were three separate `sudo -u videofy test` grants. They are the same
# three questions, asked inside the one program that is allowed to ask them, so
# a refusal still says WHICH capability is missing rather than "it failed".
[ -d "$RESOLVED" ] || die "$RESOLVED does not exist"
[ -x "$RESOLVED" ] || die "$(id -un) cannot traverse the candidate release"
[ -r "$RESOLVED/$CONFIG_REL" ] || die "$(id -un) cannot read the candidate's config module"
[ -r "$ENV_FILE" ] || die "$(id -un) cannot read $ENV_FILE (do NOT widen its permissions to fix this)"

# --- the implementation, from a root-owned copy -------------------------------
#
# NOT the shipped one. The deployment's own libraries live under /tmp and belong
# to the deploy account; running one of those through this grant would be the
# arbitrary-code-execution hole this program exists to close, wearing a
# different name.
[ -f "$IMPL" ] || die "$IMPL is missing; run deploy/production/install-sudo-hardening.sh"
IMPL_ACTUAL_OWNER="$(stat -c '%U' "$IMPL" 2>/dev/null)"
[ "$IMPL_ACTUAL_OWNER" = "$IMPL_OWNER" ]   || die "$IMPL is owned by $IMPL_ACTUAL_OWNER, not $IMPL_OWNER"
IMPL_MODE="$(stat -c '%a' "$IMPL" 2>/dev/null)"
# As BITS, not a digit pattern: matching a mode string against *[2367] only
# inspects its LAST character, so 0664 would pass while being group-writable.
[ -n "$IMPL_MODE" ] && [ $(( 0$IMPL_MODE & 0022 )) -eq 0 ] \
  || die "$IMPL is group- or world-writable ($IMPL_MODE)"
[ -x "$NODE" ] || die "$NODE is not executable"

exec "$NODE" "$IMPL" "$RESOLVED" "$ENV_FILE"
