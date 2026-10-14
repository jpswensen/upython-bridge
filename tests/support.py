"""Shared test infrastructure: a per-test hard deadline and the one right way to launch a Python child.

Why this exists
---------------
A regression test for an unbounded wait ("the bridge never answers", "Stop never returns") that
*fails* by hanging is worse than no test: it freezes the whole suite and the CI job, and it never
names the culprit.  ``TimedTestCase`` turns every hang into an ordinary test failure that says
``TIMED OUT after N s`` and shows the line the test thread was blocked on.

Usage
-----
    from tests.support import TimedTestCase, deadline

    class StopTests(TimedTestCase):
        DEADLINE_S = 20                     # optional: default for every test in this class

        def test_stop_returns(self):
            link = Link()
            self.addCleanup(link.close)                 # normal teardown (always runs)
            self.addWatchdogCleanup(link.close)         # ALSO run, from the watchdog thread, if the deadline
            ...                                         # expires: it must unblock the test thread

        @deadline(120)                      # this one test is legitimately slow
        def test_big_upload(self): ...

How it works
------------
``run()`` starts one daemon watchdog thread that waits on an Event with the deadline as its timeout
(no polling, so it costs nothing while the test runs and is joined before ``run()`` returns: a
passing test leaves no thread behind).  The clock covers setUp, the test body, tearDown and the
addCleanup functions (not setUpClass).  On expiry the watchdog

  1. marks the test timed out and snapshots the stack of the test thread,
  2. runs the registered watchdog cleanups once each, newest first (close the link, shut the socket
     down, kill the subprocess ...) so the blocked call raises or returns,
  3. if the test thread still has not returned after ``GRACE_S`` seconds, interrupts it as a last
     resort (``KeyboardInterrupt`` injected into the main thread: SIGINT via ``pthread_kill`` on
     POSIX, which also wakes a blocking syscall, and ``_thread.interrupt_main`` everywhere; on
     Windows a pure-Python wait is interrupted but a blocking socket call is not, so register a
     cleanup there).

Whatever the test thread then does (it usually raises because its socket was shut down) is demoted
into the failure text: the report is ONE failure, ``TIMED OUT after N s``, not a confusing error.
No ``signal.SIGALRM`` is used, so this works on Windows.

Environment: ``MPY_TEST_DEADLINE_SCALE=3`` multiplies every deadline (slow CI machine);
``MPY_TEST_DEADLINE_SCALE=0`` disables the watchdog (stepping through a test in a debugger).
"""
from __future__ import annotations

import os
import sys
import threading
import time
import traceback
import unittest

try:                                              # Python 3.9..3.15: the lowest-level interrupt hooks
    import _thread
except ImportError:                               # pragma: no cover - no CPython without it
    _thread = None
try:
    import signal
except ImportError:                               # pragma: no cover
    signal = None

__all__ = ["TimedTestCase", "DeadlineExceeded", "deadline", "isolated_python_argv", "child_env", "WATCHDOG_THREAD_PREFIX", "wait_until",
           "shorten_socket_close_sleep"]

WATCHDOG_THREAD_PREFIX = "test-deadline-watchdog"
SCALE_ENV = "MPY_TEST_DEADLINE_SCALE"
DEFAULT_DEADLINE_S = 60.0
DEFAULT_GRACE_S = 5.0
_STACK_LIMIT = 14


class DeadlineExceeded(AssertionError):
    """The failure recorded for a test that outlived its deadline (an AssertionError, so it is a FAIL)."""


def deadline(seconds):
    """Decorator: give one test method (or a whole TimedTestCase class) its own deadline in seconds.

    Order-independent with other decorators (``skipIf``, ``functools.wraps`` wrappers copy attributes).
    A method deadline beats the class ``DEADLINE_S``; a class decorator sets ``DEADLINE_S``."""
    seconds = float(seconds)
    if not seconds > 0:
        raise ValueError("deadline must be a positive number of seconds, got %r" % (seconds,))

    def decorate(obj):
        if isinstance(obj, type):
            obj.DEADLINE_S = seconds
        else:
            obj._deadline_s = seconds
        return obj

    return decorate


def _scale():
    """Float multiplier from the environment; 0 (or less) means 'no watchdog'; junk means 1."""
    raw = os.environ.get(SCALE_ENV, "").strip()
    if not raw:
        return 1.0
    try:
        return float(raw)
    except ValueError:
        return 1.0


def _fmt_s(seconds):
    return ("%g" % seconds)


class _State(object):
    """Everything one run() shares with its watchdog; a fresh one per run so a TestCase can be re-run."""

    def __init__(self, seconds, grace, test_ident):
        self.seconds = seconds
        self.grace = grace
        self.test_ident = test_ident                  # the thread that executes the test body
        self.lock = threading.Lock()
        self.done = threading.Event()                 # set by run() as soon as the test thread is back
        self.cleanups = []                            # [(label, fn, args, kwargs)], run newest first, once
        self.expired = False                          # the deadline passed while the test was running
        self.returned = False                         # run() got control back from the test (no more interrupts)
        self.report = []                              # lines for the failure text, in order
        self.induced = []                             # exceptions the unblocked test thread raised (demoted)
        self.interrupted = False
        self.thread = None


class _ResultProxy(object):
    """Stands in for the real TestResult while a test runs.  Before expiry everything is forwarded
    unchanged.  After expiry, outcomes reported by the (unblocked) test thread are demoted into the single
    TIMED OUT failure that run() adds afterwards, so one hang is one failure, not a failure plus an error."""

    def __init__(self, real, state):
        self._real = real
        self._st = state

    def __getattr__(self, name):                       # startTest, stopTest, failfast, buffer, addSkip ...
        return getattr(self._real, name)

    def _demote(self, kind, err):
        st = self._st
        with st.lock:
            if st.expired:
                if err is not None:
                    st.induced.append((kind, err))
                return True
        return False

    def addError(self, test, err):
        if not self._demote("error", err):
            self._real.addError(test, err)

    def addFailure(self, test, err):
        if not self._demote("failure", err):
            self._real.addFailure(test, err)

    def addSuccess(self, test):
        if not self._demote("success", None):
            self._real.addSuccess(test)

    def addSkip(self, test, reason):
        if not self._demote("skip", None):
            self._real.addSkip(test, reason)

    def addExpectedFailure(self, test, err):
        if not self._demote("expected failure", err):
            self._real.addExpectedFailure(test, err)

    def addUnexpectedSuccess(self, test):
        if not self._demote("unexpected success", None):
            self._real.addUnexpectedSuccess(test)


class TimedTestCase(unittest.TestCase):
    """unittest.TestCase with a per-test hard deadline (see the module docstring)."""

    DEADLINE_S = DEFAULT_DEADLINE_S                    # per-class default; @deadline(n) on a method overrides it
    GRACE_S = DEFAULT_GRACE_S                          # how long the cleanups get to unblock the test thread

    _dl_state = None

    # ------------------------------------------------------------------ public hook
    def addWatchdogCleanup(self, fn, *args, **kwargs):
        """Register ``fn(*args, **kwargs)`` to be called from the watchdog thread, once, if (and only if) the
        deadline expires.  Use it to close the link / shut the socket down / kill the subprocess that the test
        thread is blocked on.  Newest first.  Registering after expiry runs it immediately, in the calling thread.  A cleanup that
        raises is reported in the failure text and never stops the others.  Normal teardown stays addCleanup."""
        st = self._dl_state
        if st is None:
            raise RuntimeError("addWatchdogCleanup() is only valid while the test is running")
        label = getattr(fn, "__qualname__", None) or repr(fn)
        entry = (label, fn, args, kwargs)
        with st.lock:
            expired = st.expired
            if not expired:
                st.cleanups.append(entry)
        if expired:
            self._run_cleanup(st, entry)                # too late to queue: run it now, in the calling thread

    # ------------------------------------------------------------------ deadline resolution
    def effective_deadline(self):
        """Seconds this test gets (method decorator > class DEADLINE_S, times the env scale), or None if disabled."""
        method = getattr(self, self._testMethodName, None)
        seconds = getattr(method, "_deadline_s", None)
        if seconds is None:
            seconds = self.DEADLINE_S
        scale = _scale()
        if scale <= 0:
            return None
        return float(seconds) * scale

    def _is_skipped(self):
        method = getattr(self, self._testMethodName, None)
        return bool(getattr(type(self), "__unittest_skip__", False) or getattr(method, "__unittest_skip__", False))

    # ------------------------------------------------------------------ the watchdog
    @staticmethod
    def _run_cleanup(st, entry):
        label, fn, args, kwargs = entry
        try:
            fn(*args, **kwargs)
        except BaseException as exc:                    # noqa: BLE001 - a broken cleanup must not hide the timeout
            st.report.append("watchdog cleanup %s raised %s: %s" % (label, type(exc).__name__, exc))
        else:
            st.report.append("watchdog cleanup %s ran" % label)

    @classmethod
    def _drain_cleanups(cls, st):
        """Run every queued cleanup exactly once, newest first (pop under the lock, call outside it)."""
        while True:
            with st.lock:
                if not st.cleanups:
                    return
                entry = st.cleanups.pop()
            cls._run_cleanup(st, entry)

    @staticmethod
    def _interrupt_test_thread(st):
        """Last resort: raise KeyboardInterrupt in the test thread.  Only possible for the main thread."""
        if _thread is None or st.test_ident != threading.main_thread().ident:
            st.report.append("test thread is not the main thread: it cannot be interrupted, the suite stays blocked")
            return False
        with st.lock:
            if st.returned:
                return False
            if signal is not None and hasattr(signal, "pthread_kill"):
                try:
                    signal.pthread_kill(st.test_ident, signal.SIGINT)    # also breaks a blocking syscall (EINTR)
                except (OSError, ValueError):
                    pass
            _thread.interrupt_main()
            st.interrupted = True
        return True

    def _watch(self, st):
        if st.done.wait(min(st.seconds, threading.TIMEOUT_MAX)):
            return                                      # the test finished in time: the common, free path
        with st.lock:
            if st.returned:                             # finished in the same instant: not a timeout
                return
            st.expired = True
        frame = sys._current_frames().get(st.test_ident)
        stack = "".join(traceback.format_stack(frame, limit=_STACK_LIMIT)) if frame is not None else "(unavailable)\n"
        st.report.insert(0, "the test thread was blocked here (most recent call last):\n" + stack.rstrip("\n"))
        self._drain_cleanups(st)
        if not st.done.wait(st.grace):
            if self._interrupt_test_thread(st):
                st.report.append("the test thread was still blocked %s s after the cleanups: interrupted it "
                                 "(its tearDown and addCleanup functions did NOT run; resources may leak)"
                                 % _fmt_s(st.grace))
                if not st.done.wait(st.grace):
                    st.report.append("the test thread is STILL blocked after the interrupt; the suite will hang. "
                                     "Register an addWatchdogCleanup() that unblocks it.")

    # ------------------------------------------------------------------ run()
    def run(self, result=None):
        seconds = None if self._is_skipped() else self.effective_deadline()
        if seconds is None:
            return super().run(result)
        owned = result is None
        real = self.defaultTestResult() if owned else result
        if owned:
            start = getattr(real, "startTestRun", None)
            if start is not None:
                start()
        st = _State(seconds, float(self.GRACE_S), threading.get_ident())
        self._dl_state = st
        st.thread = threading.Thread(target=self._watch, args=(st,), daemon=True,
                                     name="%s:%s" % (WATCHDOG_THREAD_PREFIX, self.id()))
        st.thread.start()
        try:
            try:
                super().run(_ResultProxy(real, st))
            except KeyboardInterrupt:
                if not st.expired:                       # a real Ctrl-C by a human: let it through
                    st.done.set()
                    raise
        finally:
            while True:                                  # idempotent: a late injected interrupt may land in here
                try:
                    self._finalise(st)
                    break
                except KeyboardInterrupt:
                    if not st.expired:
                        raise
            self._dl_state = None
        if st.expired:
            self._report_timeout(real, st)
        if owned:
            stop = getattr(real, "stopTestRun", None)
            if stop is not None:
                stop()
        return real

    @staticmethod
    def _finalise(st):
        st.done.set()                                    # wakes the watchdog; no lock needed, cannot block
        with st.lock:
            st.returned = True                           # no interrupt may be injected after this point
        st.thread.join()                                 # waits for running cleanups: no thread leaks, no races

    def _report_timeout(self, result, st):
        lines = ["TIMED OUT after %s s (per-test deadline for %s; raise it with @deadline(seconds) only if the "
                 "test is legitimately slow)" % (_fmt_s(st.seconds), self.id())]
        lines.extend(st.report)
        for kind, err in st.induced:
            exc = err[1]
            lines.append("after the cleanups the test thread reported (demoted) %s: %s: %s"
                         % (kind, type(exc).__name__, exc))
        message = "\n".join(lines)
        try:
            raise DeadlineExceeded(message)
        except DeadlineExceeded:
            exc_info = sys.exc_info()
        result.addFailure(self, exc_info)


# ---------------------------------------------------------------------------------------- waiting


def wait_until(predicate, timeout, what="the condition", interval=0.005):
    """Wait for ``predicate()`` to become truthy and return its value; raise AssertionError after ``timeout`` s.
    The bounded replacement for ``time.sleep(n)`` used as synchronisation (tests/README.md): it returns the moment
    the state is reached and never waits a fixed time.  Prefer a real signal (Event, Queue, process exit, socket
    data) when one exists; use this when the only way to know is to look at state."""
    end = time.monotonic() + timeout
    tick = threading.Event()                       # never set: only a cheap interruptible timed wait
    while True:
        value = predicate()
        if value:
            return value
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise AssertionError("timed out after %s s waiting for %s" % (_fmt_s(timeout), what))
        tick.wait(min(interval, remaining))


# ---------------------------------------------------------------------------------------- child processes


def isolated_python_argv(*args):
    """argv for a Python child process in the project's standard hermetic mode: ``-I`` (ignores the cwd, user
    site and every PYTHON* variable) plus ``-B`` and ``-X utf8``.  Those two MUST be flags: under ``-I`` the
    environment variables PYTHONDONTWRITEBYTECODE / PYTHONUTF8 are ignored (old-defects review, finding #12), so
    putting them in the env silently writes __pycache__ into bridge/vendor and leaves the child in the locale
    encoding on Windows.  ``-u`` keeps pipes unbuffered."""
    return [sys.executable, "-I", "-B", "-X", "utf8", "-u"] + list(args)


def child_env(**extra):
    """Environment for a test subprocess: the parent's, with MPY_SAFE_MODE=1 forced on and MPY_REAL_PORT removed
    (a test subprocess may never be handed a real port), plus ``extra``."""
    env = dict(os.environ)
    env["MPY_SAFE_MODE"] = "1"
    env.pop("MPY_REAL_PORT", None)
    env.update(extra)
    return env


def shorten_socket_close_sleep(seconds=0.02):
    """Tests only: cap the ``time.sleep(0.3)`` that pyserial 3.5's ``socket://`` close() ends with.

    The vendored ``serial.urlhandler.protocol_socket.close`` sleeps 0.3 s "in case of quick reconnects, give the server
    some time". Every Link.close() against a fake board paid that, i.e. 0.3 s per test (the single biggest item of the
    core trio's wall time, which is otherwise 15 s of CPU). The fake board re-listens within milliseconds of the client
    going away, so a short pause is enough. Only that module's ``time`` name is wrapped (nothing global is patched and
    vendor/ is untouched); real serial ports never go through this code. Idempotent."""
    import serial.urlhandler.protocol_socket as ps
    real = ps.time
    if getattr(real, "_mpy_capped", False):
        return

    class _CappedTime(object):
        _mpy_capped = True

        def __getattr__(self, name):
            return getattr(real, name)

        @staticmethod
        def sleep(secs):
            real.sleep(min(secs, seconds))

    ps.time = _CappedTime()
