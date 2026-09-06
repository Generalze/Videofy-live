#!/usr/bin/env bash
# @author masterzee001
#
# What a deployment must own before it is allowed to change anything.
#
# THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE. `atomic-deploy.sh` shipped its
# libraries to the box and unpacked them over a shared path, and only then
# tried to take the transaction lock:
#
#     caller B                      caller C
#     ships engine                  ships engine
#     installs into REMOTE_LIB      REPLACES REMOTE_LIB   <-- B is mid-flight
#     takes the lock                fails to take the lock
#     ...runs C's libraries
#
# The losing caller had already overwritten the winner's executable machinery
# before it discovered it had lost. Serialising the release pointer is no help
# at all when the code doing the serialising can be swapped underneath.
#
# So ordering is not left to whoever edits the script next. It is a function:
# the lock is taken first, and the shipping callback is not even reachable
# until it succeeds.
#
# BOTH HALVES ARE NEEDED, and this is only the first. A transaction also ships
# into a directory unique to itself, so that even a caller which somehow ran
# out of order could not be writing where the winner reads.

# Take ownership, then install the machinery. Never the other way round.
#
# `lock_fn`  acquire the transaction lock; non-zero means somebody else owns it
# `ship_fn`  install this transaction's private machinery on the host
#
# Returns non-zero without ever calling `ship_fn` when the lock is not ours,
# which is the whole point: a caller that has lost must not have touched
# anything by the time it finds out.
transaction_begin() {
  local lock_fn="$1" ship_fn="$2"
  if ! "$lock_fn"; then
    echo "  nothing was shipped, installed or replaced on the host." >&2
    return 1
  fi
  if ! "$ship_fn"; then
    echo "REFUSED: could not install this transaction's machinery on the host." >&2
    return 1
  fi
  return 0
}

# A directory name no other invocation will choose.
#
# TIME ALONE IS NOT ENOUGH: two deployments started in the same second would
# collide, and colliding is exactly the failure being designed out. The pid
# separates callers on one machine and RANDOM separates callers on different
# ones, which is the case that matters when two people deploy at once.
transaction_nonce() {
  printf '%s-%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$$" "${RANDOM}${RANDOM}"
}

# Is the deployment engine itself committed, and which commit is it?
#
# WHY THIS IS A FUNCTION IN A LIBRARY rather than a few lines in the deploy
# script: it has to be testable. The first live production preparation was
# retried five times, and between attempts this very engine was edited to fix
# real transport defects -- while every attempt still reported the candidate as
# a certified SHA. The application was exactly that commit; the machinery
# qualifying it was uncommitted operator-side code, and nothing in the logs
# distinguished the two.
#
# `repo` is a parameter for the same reason: a guard that can only run against
# the one checkout it lives in cannot be falsified.
engine_is_committed() {
  local repo="$1" label="${2:-deployment engine}"
  local head dirty

  head="$(git -C "$repo" rev-parse --verify --quiet HEAD 2>/dev/null || true)"
  if [ -z "$head" ]; then
    echo "REFUSED: the $label has no Git HEAD to identify it." >&2
    echo "  A production deployment must be able to say which committed bytes" >&2
    echo "  performed it." >&2
    return 1
  fi

  # Untracked files count. An untracked activation.sh sitting beside the
  # committed one is exactly the shape of the problem this exists to stop.
  dirty="$(git -C "$repo" status --porcelain --untracked-files=all -- deploy 2>/dev/null)"
  if [ -n "$dirty" ]; then
    echo "REFUSED: the $label is not committed." >&2
    echo "  Production may not be qualified by machinery that exists only in a" >&2
    echo "  working tree: the release would name a certified SHA while the code" >&2
    echo "  checking it names nothing at all." >&2
    printf '%s\n' "$dirty" | sed 's/^/    /' >&2
    echo "  Commit these, or deploy from a clean checkout." >&2
    return 1
  fi
  printf '%s' "$head"
  return 0
}

# Is this host set up for atomic releases at all?
#
# THE FIRST LIVE PREPARATION DIED ON THIS AND SAID THE WRONG THING. The
# deployment root is root-owned, so the deploy identity could not create
# `.deploy.lock`; the failure surfaced from `flock` and was reported as
# "another deployment operation holds the lock". An operator reading that waits
# for a deployment that does not exist. The cause and the message had nothing
# to do with each other.
#
# So the bootstrap is checked FIRST, as its own question, and answered in its
# own words. Provisioning stays in `install.sh`: a deploy that silently creates
# the paths it needs would hide a half-provisioned host instead of reporting
# one, and it would need write access to the root to do it -- which is exactly
# the permission we are deliberately not granting.
#
# Prints a single machine-readable word so a caller can tell the cases apart.
atomic_bootstrap_state() {
  local root="$1"
  [ -n "$root" ] || { printf 'missing-root'; return 1; }
  [ -d "$root" ] || { printf 'missing-root'; return 1; }
  if [ ! -e "$root/releases" ]; then printf 'missing-releases'; return 1; fi
  if [ ! -d "$root/releases" ]; then printf 'releases-not-a-directory'; return 1; fi
  if [ ! -w "$root/releases" ]; then printf 'releases-not-writable'; return 1; fi
  if [ ! -e "$root/.deploy.lock" ]; then printf 'missing-lock'; return 1; fi
  if [ ! -f "$root/.deploy.lock" ]; then printf 'lock-not-a-regular-file'; return 1; fi
  # Openable for append is what `flock` needs; -w alone would pass on a file
  # the deploy identity cannot actually open.
  if ! ( exec 8>>"$root/.deploy.lock" ) 2>/dev/null; then
    printf 'lock-not-openable'; return 1
  fi
  #
  # AND SOMETHING MUST BE ABLE TO MOVE THE POINTER.
  #
  # On 2026-09-06 everything above this passed and the convergence still could
  # not publish: the root is root-owned, so the deploy identity cannot replace
  # `current`, and that was discovered only AFTER a release had been built.
  # Publication authority is part of being provisioned, so it is proven here.
  if [ ! -w "$root" ]; then
    local helper="${ATOMIC_PUBLISH_HELPER:-/usr/local/sbin/videofy-publish-current}"
    [ -e "$helper" ] || { printf 'missing-publication-helper'; return 1; }
    [ -x "$helper" ] || { printf 'publication-helper-not-executable'; return 1; }
    # Writability is tested before ownership because it is the more specific
    # objection: a helper somebody else can rewrite is a helper that runs
    # somebody else's code as root, whoever happens to own the file today.
    #
    # Tested as BITS, not as a digit pattern. The first version of this matched
    # the mode string against *[2367], which only ever inspects the LAST
    # character -- so 0775, group-writable by exactly the account that must not
    # be able to rewrite it, passed. Masking with 0022 asks the question that
    # was meant: may anyone but the owner write this?
    local helper_mode
    helper_mode="$(stat -c '%a' "$helper" 2>/dev/null)"
    if [ -z "$helper_mode" ] || [ $(( 0$helper_mode & 0022 )) -ne 0 ]; then
      printf 'publication-helper-writable'; return 1
    fi
    [ "$(stat -c '%U' "$helper" 2>/dev/null)" = 'root' ] || {
      printf 'publication-helper-not-root-owned'; return 1; }
    # Invocability, proven rather than assumed: an installed helper the deploy
    # account may not actually run is the same outage, discovered later.
    sudo -n "$helper" --check >/dev/null 2>&1 || {
      printf 'publication-authority-unavailable'; return 1; }
  fi
  printf 'ok'
  return 0
}

# The refusal an operator can act on, kept next to the check that produces it.
atomic_bootstrap_refusal() {
  local root="$1" state="$2" env_name="${3:-production}"
  echo "REFUSED: ATOMIC DEPLOYMENT BOOTSTRAP INCOMPLETE ($state)." >&2
  echo "  $root is not provisioned for atomic releases." >&2
  case "$state" in
    missing-root)             echo "  The deployment root does not exist." >&2 ;;
    missing-releases)         echo "  $root/releases does not exist." >&2 ;;
    releases-not-a-directory) echo "  $root/releases exists but is not a directory." >&2 ;;
    releases-not-writable)    echo "  $root/releases is not writable by the deploy identity." >&2 ;;
    missing-lock)             echo "  $root/.deploy.lock does not exist." >&2 ;;
    lock-not-a-regular-file)  echo "  $root/.deploy.lock is not a regular file." >&2 ;;
    lock-not-openable)        echo "  $root/.deploy.lock cannot be opened by the deploy identity." >&2 ;;
    missing-publication-helper)
      echo "  $root is root-owned, so the deploy identity cannot replace" >&2
      echo "  $root/current, and the publication helper is not installed." >&2
      echo "  ATOMIC PUBLICATION BOOTSTRAP INCOMPLETE." >&2 ;;
    publication-helper-not-executable)
      echo "  The publication helper exists but is not executable." >&2 ;;
    publication-helper-not-root-owned)
      echo "  The publication helper is not owned by root; it would run the" >&2
      echo "  deploy identity's own code with root privilege." >&2 ;;
    publication-helper-writable)
      echo "  The publication helper is group- or world-writable, which is the" >&2
      echo "  same problem by another route." >&2 ;;
    publication-authority-unavailable)
      echo "  The publication helper is installed but this identity may not" >&2
      echo "  invoke it. Check the sudoers entry." >&2 ;;
  esac
  echo "  THIS IS NOT A BUSY LOCK. Nothing else is deploying; the host was never" >&2
  echo "  set up. Run the production bootstrap, which creates these as the deploy" >&2
  echo "  owner without making the root itself writable:" >&2
  echo "    sudo bash deploy/$env_name/install.sh" >&2
}

# Make a shipment safe to execute on the host, whatever wrote it.
#
# A COPY IS NORMALISED, NEVER THE SOURCE. This repository is worked on from
# Windows, where git's autocrlf materialises shell libraries with CRLF; bash on
# the host reads the trailing carriage return as part of the command and dies
# naming an invisible character. Rewriting the working tree to fix that would
# make deploying a mutation of the developer's checkout, which is its own kind
# of surprise.
shipment_normalise() {
  local dir="$1"
  [ -d "$dir" ] || return 1
  find "$dir" -type f \( -name '*.sh' -o -name '*.mjs' -o -name '*.py' \) \
    -exec sed -i 's/\r$//' {} +
}
