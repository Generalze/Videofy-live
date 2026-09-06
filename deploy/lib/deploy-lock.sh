#!/usr/bin/env bash
# @author masterzee001
#
# One deployment transaction at a time, enforced by the kernel.
#
# WHAT ATOMIC PUBLICATION DOES NOT BUY YOU. Renaming `current` is atomic, and
# that makes any single instant unambiguous. It says nothing about two
# deployments running at once, because a deployment is not an instant -- it is
# prepare, publish, restart, health, prove, smoke, and each of those steps
# reads state the other transaction is busy changing:
#
#     deploy B                     deploy C
#     previous=A                   previous=A
#     prepare B                    prepare C
#     publish B
#                                  publish C
#     restart services
#                                  restart services
#     prove running B  -> FAILS, because C is running
#     roll back to A
#                                  prove running C -> maybe
#
# Both believed they were the owner, both were right about the pointer, and the
# system ends wherever the interleaving left it. No amount of atomicity at the
# rename fixes it; the TRANSACTION needs an owner.
#
# WHY flock AND NOT A LOCKFILE. A lockfile someone has to delete after a crash
# is a lock that will eventually be deleted while a deploy is running, by
# somebody who has waited long enough and reasoned that it must be stale. An
# `flock` on an open descriptor is owned by the process: it is released when
# the process exits, however it exits -- normally, on error, on SIGKILL, on the
# SSH connection dropping. There is no stale state and nothing to clean up.
#
# `state` is deliberately NOT locked. It only reads, and a diagnostic command
# that blocks because a deployment is in progress is a diagnostic command
# nobody can use at the moment they most need it.

# The lock lives in the environment's own root, beside the releases it
# serialises -- never inside `current` (which a deployment replaces) and never
# inside a release directory (which is immutable and may be swept away).
atomic_lock_path() {
  printf '%s/.deploy.lock' "${ATOMIC_ROOT:?ATOMIC_ROOT is required for the deploy lock}"
}

# Take the lock for the life of this process, or refuse immediately.
#
# NON-BLOCKING ON PURPOSE. A second deployment that waits is a second
# deployment that will run later against a system the first one changed, using
# arguments the operator chose before any of it happened. Refusing now, loudly,
# is the honest answer: whoever is deploying should decide what to do next.
atomic_lock_acquire() {
  # THE TRANSACTION MAY BE OWNED BY AN OUTER PROCESS.
  #
  # A production deployment spans two machines: the box prepares, publishes,
  # restarts and verifies, and the CALLER runs the public smoke and only then
  # asks the box to finalise. If the box released the lock when its SSH command
  # exited, a second deployment could acquire it and publish during that smoke
  # -- and the first would then finalise DEPLOY-STATE naming a release that is
  # no longer current.
  #
  # So the caller holds the lock for the whole transaction, in a session whose
  # lifetime is the SSH connection, and tells the inner operations that
  # ownership is already established. This is not a way to skip the lock: the
  # holder took the same flock, and a second caller cannot take it.
  if [ "${ATOMIC_LOCK_EXTERNAL:-0}" = "1" ]; then
    return 0
  fi
  local path
  path="$(atomic_lock_path)" || return 1
  # 9 is high enough not to collide with anything the deploy scripts use, and
  # the descriptor is what holds the lock -- so it must stay open for the whole
  # transaction rather than being closed at the end of this function.
  exec 9>>"$path" || {
    echo "REFUSED: cannot open the deploy lock at $path" >&2
    return 1
  }
  if ! flock -n 9; then
    echo "REFUSED: another deployment operation holds the lock at $path." >&2
    echo "  prepare, deploy and rollback are one transaction each and cannot" >&2
    echo "  interleave: two owners would publish, restart and verify against" >&2
    echo "  each other's state. Wait for it to finish, or inspect with:" >&2
    echo "    bash deploy/atomic-deploy.sh ${ATOMIC_ENV:-production} state" >&2
    #
    # WHO HOLDS IT, NAMED. An `flock` belongs to the OPEN FILE DESCRIPTION, and
    # every child a deployment spawns -- npm, git, node, even a `sleep` --
    # inherits it. So the lock is released when the process TREE goes away, not
    # merely when the command that took it does: one orphaned child is enough
    # to keep it. That is the right conservative behaviour (an orphan may still
    # be writing) but it is baffling without evidence, so the holders are
    # listed rather than left for somebody to work out.
    if command -v fuser >/dev/null 2>&1; then
      echo "  held by:" >&2
      fuser -v "$path" 2>&1 | sed 's/^/    /' >&2
    fi
    return 1
  fi
  # Recorded for a human reading the lock file, never read back as authority --
  # the kernel owns the lock, this is only a note about who took it.
  printf 'pid=%s at=%s env=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${ATOMIC_ENV:-?}" >&9
  return 0
}

# Released by the kernel when the process exits. This exists so a long-running
# caller can hand the lock back early and so the intent is visible in the code.
atomic_lock_release() {
  exec 9>&- 2>/dev/null || true
}
