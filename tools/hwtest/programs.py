"""programs.py - the device programs the harness itself authors and sends with ``run`` (phase C).

They only print, sleep, read ``sys.stdin``, raise, or loop; ``confine.scan_program`` re-checks every one of them when it is
written and again before each ``run`` (no pins, no files, no reset, no other imports than sys/time/select).  They run on the
fake board AND on a real MicroPython VM, so they stick to code every port understands.
"""
from __future__ import annotations

__all__ = ["PROGRAMS", "BIG_OUTPUT_BYTES", "BIG_LINE", "BIG_LINES"]

BIG_LINE = 1023            # characters per line of the big-output program
BIG_LINES = 1024           # => 1 MiB of payload (plus CRLF per line on the wire)
BIG_OUTPUT_BYTES = (BIG_LINE + 2) * BIG_LINES

# file names contain spaces and parentheses on purpose: tracebacks must cite the local path (RQ-CLOUD-1)
PROGRAMS = {
    "print_ok": ("prog print (ok).py", 'print("harness hello")\n'),
    "syntax_error": ("prog syntax (bad).py", "def broken(:\n    pass\n"),
    "raise_error": ("prog raise (1).py", 'print("before")\nraise ValueError("harness boom")\n'),
    "stdin_echo": ("prog stdin (echo).py",
                   "import sys\n"
                   'print("READY")\n'
                   "while True:\n"
                   "    c = sys.stdin.read(1)\n"
                   '    print("key:" + repr(c))\n'
                   '    if c == "q":\n'
                   "        break\n"
                   'print("DONE")\n'),
    "loop": ("prog loop (stop me).py",
             "import time\n"
             'print("LOOPING")\n'
             "while True:\n"
             "    time.sleep(0.02)\n"),
    "big_output": ("prog big (1 MiB).py",
                   'line = "x" * %d\n'
                   "for _ in range(%d):\n"
                   "    print(line)\n" % (BIG_LINE, BIG_LINES)),
    "counter": ("prog counter (fresh vm).py",
                "try:\n"
                "    harness_n\n"
                "except NameError:\n"
                "    harness_n = 0\n"
                "harness_n += 1\n"
                'print("count", harness_n)\n'),
}
