"""A minimal ``fcntl`` for Windows, because Danus imports one function from it.

``danus/orchestration/cli.py`` opens with ``import fcntl`` and then uses exactly
one call: ``flock()`` as an idempotency lock around ``.pid.lock``. Nothing else
in Danus touches the module. That single fact is what lets the control plane
run natively on Windows instead of requiring WSL: a whole-file lock built on
``msvcrt.locking`` has the same meaning for the only thing it is used for.

Deliberately partial:

- ``LOCK_SH`` is accepted and mapped to an exclusive lock. Danus never takes a
  shared lock; silently honouring one would be pretending to support something
  nothing tests.
- The lock is one byte at offset 0, which is exactly how ``flock`` behaves for
  readers here (whole-file, advisory). Other processes only ever use this same
  module, so the range is consistent.

This file only exists on ``sys.path`` for the interpreter this plugin starts
(see ``launch.js``); it does not shadow anything system-wide.
"""

import msvcrt
import os

LOCK_SH = 0x1
LOCK_EX = 0x2
LOCK_NB = 0x4
LOCK_UN = 0x8

__all__ = ["flock", "LOCK_SH", "LOCK_EX", "LOCK_NB", "LOCK_UN"]


def flock(file, operation):
    """Lock or unlock the first byte of an open file, like ``flock(2)``.

    ``file`` may be a file object or a file descriptor, matching ``fcntl.flock``.
    Raises ``BlockingIOError`` when ``LOCK_NB`` was asked for and the lock is
    held — that is the exception ``cli.py`` catches.
    """
    fd = file if isinstance(file, int) else file.fileno()

    # msvcrt locks from the *current* position, so every call must start at 0
    # or the second lock lands on a different byte and never conflicts.
    os.lseek(fd, 0, os.SEEK_SET)

    if operation & LOCK_UN:
        try:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            # Unlocking something not held is a no-op for flock(2); mirror that.
            pass
        return

    mode = msvcrt.LK_NBLCK if operation & LOCK_NB else msvcrt.LK_LOCK
    try:
        msvcrt.locking(fd, mode, 1)
    except OSError as error:
        if operation & LOCK_NB:
            # BlockingIOError is what `cli.py` expects; msvcrt raises plain
            # OSError with errno 13, which would read as a permission problem.
            raise BlockingIOError(11, "the pid lock is held by another process") from error
        raise
