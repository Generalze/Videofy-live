#!/usr/bin/env python3
"""Turn the served web directory into the structural pointer, in one instant.

@author masterzee001

THE ONE-TIME CONVERGENCE STEP, and the only part of it that touches something
the public is currently reading. Everything else in the atomic release model
moves a pointer that already exists; this creates one where a real directory
stands, and `www` is what Caddy serves right now.

The obvious sequence is not good enough::

    mv www www.pre-convergence          # <- the site is 404 from here
    ln -sfn current/www www.publishing
    mv -Tf www.publishing www           # <- until here

Between those renames there is no `www`, and Caddy answers 404 to everyone. It
is short, and "short" is the same word that described the pointer gap this
whole design exists to remove. Writing it down as an accepted maintenance
window would have been accepting the exact class of defect the milestone was
sent back to fix, one layer down.

`renameat2(RENAME_EXCHANGE)` swaps two paths atomically: both exist before,
both exist after, and there is no instant in which either is missing. Probed on
this host before use -- ext4, kernel 6.8 -- and refused rather than degraded if
the syscall is unavailable, because a silent fallback to the 404 sequence would
reintroduce the window precisely where nobody would look for it again.

    exchange-web-pointer.py <www> <prepared-symlink>

Afterwards `<www>` IS the symlink and `<prepared-symlink>` is the old real
directory, kept, so the reverse is one more exchange.
"""

import ctypes
import ctypes.util
import errno
import os
import sys

# x86_64. Deliberately not guessed for other architectures: a wrong syscall
# number is not an error, it is a different syscall.
SYS_RENAMEAT2 = 316
RENAME_EXCHANGE = 2
AT_FDCWD = -100


def exchange(first: str, second: str) -> None:
    if os.uname().machine != "x86_64":
        sys.exit(f"REFUSED: syscall number is only known for x86_64, not {os.uname().machine}")

    for path in (first, second):
        if not os.path.lexists(path):
            sys.exit(f"REFUSED: {path} does not exist; an exchange needs both sides")

    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    result = libc.syscall(
        SYS_RENAMEAT2, AT_FDCWD, first.encode(), AT_FDCWD, second.encode(), RENAME_EXCHANGE
    )
    if result != 0:
        code = ctypes.get_errno()
        name = errno.errorcode.get(code, str(code))
        print(f"REFUSED: renameat2(RENAME_EXCHANGE) failed: {name}", file=sys.stderr)
        if code in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
            print(
                "  This kernel or filesystem cannot exchange atomically. Do NOT fall back\n"
                "  to mv-then-link: that reintroduces an interval with no web root. Take\n"
                "  the documented maintenance window deliberately instead.",
                file=sys.stderr,
            )
        sys.exit(1)

    print(f"exchanged: {first} <-> {second}")
    print(f"  {first} is now a symlink: {os.path.islink(first)} -> {os.readlink(first) if os.path.islink(first) else '-'}")
    print(f"  {second} now holds the previous real directory (kept for reversal)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: exchange-web-pointer.py <www> <prepared-symlink>")
    exchange(sys.argv[1], sys.argv[2])
