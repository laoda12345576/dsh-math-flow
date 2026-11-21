"""Windows fixes for the two ``os`` calls Danus makes, loaded automatically.

CPython imports ``sitecustomize`` at startup when it is importable, so putting
this directory first on ``PYTHONPATH`` is enough to apply both patches to the
interpreter the plugin spawns — and to nothing else on the machine.

Why each one is necessary, in the order they would bite:

1. ``os.kill(pid, 0)``. On POSIX this is the standard "does this process exist"
   probe. On Windows CPython forwards it to ``TerminateProcess(handle, 0)``:
   the liveness check in ``cli.py::_alive`` would *kill the worker it is
   checking*, and then report it dead. That is not a cosmetic difference, so the
   probe is reimplemented on ``OpenProcess``.

2. ``os.getpgid`` / ``os.killpg``. Windows has no process groups. Both are
   missing attributes, and ``cli.py`` only catches ``ProcessLookupError`` and
   ``PermissionError``, so the AttributeError would escape and crash the verb.
   ``taskkill /T`` kills the tree — the loop *and* its codex child — which is
   what ``killpg`` was there for.

``os.kill`` is left alone for every non-zero signal: a forced stop should be
forceful, and the ``killpg`` above is what the force path actually calls.
"""

import ctypes
import os
import subprocess
import sys

if sys.platform == "win32":  # pragma: no cover - the whole file is Windows-only
    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _ERROR_ACCESS_DENIED = 5

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    _kernel32.OpenProcess.restype = ctypes.c_void_p
    _kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    _kernel32.CloseHandle.restype = ctypes.c_int

    _original_kill = os.kill

    def _probe(pid):
        """Return normally if the process exists, raise the errno it deserves."""
        handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, 0, int(pid))
        if handle:
            _kernel32.CloseHandle(handle)
            return
        error = ctypes.get_last_error()
        if error == _ERROR_ACCESS_DENIED:
            # It exists; it just is not ours. cli.py treats this as alive.
            raise PermissionError(13, "access denied", pid)
        raise ProcessLookupError(3, "no such process", pid)

    def kill(pid, sig):
        if sig == 0:
            _probe(pid)
            return 0
        return _original_kill(pid, sig)

    os.kill = kill

    if not hasattr(os, "getpgid"):
        os.getpgid = lambda pid: int(pid)

    if not hasattr(os, "killpg"):
        def killpg(pgid, sig):
            # /T: the loop and every child it spawned. /F: no negotiation.
            result = subprocess.run(
                ["taskkill", "/PID", str(int(pgid)), "/T", "/F"],
                capture_output=True,
                text=True,
            )
            if result.returncode not in (0, 128):  # 128 = already gone
                raise ProcessLookupError(3, result.stderr.strip() or "taskkill failed", pgid)

        os.killpg = killpg
