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
