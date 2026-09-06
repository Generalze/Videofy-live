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
