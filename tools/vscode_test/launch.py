#!/usr/bin/env python3
"""Isolated VS Code launcher for the uPy Bridge extension-host tests (CLAUDE.md, "VS Code / Electron launches").

    python3.13 -B tools/vscode_test/launch.py --suite smoke
    python3.13 -B tools/vscode_test/launch.py --suite all [--timeout 180]
    python3.13 -B tools/vscode_test/launch.py --suite python --with-python-extensions
    python3.13 -B tools/vscode_test/launch.py --suite coexist --with-old-extension
    python3.13 -B tools/vscode_test/launch.py --suite intellisense          # real Pylance on a made-up "acme" firmware project
    python3.13 -B tools/vscode_test/launch.py --suite intellisense-spikes   # S-04 d/e/f: missing extends target, settings-only tier, config extraPaths

What one run does (stdlib only; macOS first, the Windows paths are coded but UNTESTED):

  1. Scratch root /tmp/mpyvs/<id>/ {ud, ext, ws, out, board}. /tmp/mpyvs is short on purpose (macOS IPC socket paths fail above
     103 characters). The instructor's real profile (~/Library/Application Support/Code, ~/.vscode/extensions) is never used;
     ms-python.* folders are COPIED (never linked) from ~/.vscode/extensions when asked for, and the old extension is
     extracted from its VSIX (read-only use of the old repository).
  2. A FAKE board (tools/fakeboard.py, socket://127.0.0.1:PORT) is started IN THIS PROCESS. The sample workspace gets
     .vscode/settings.json with the documented `port` setting pointing at it, auto-sync off (modal prompts cannot be answered),
     and the absolute path of this Python as `pythonPath`.
  3. /Applications/Visual Studio Code.app/Contents/MacOS/Code is started with only isolated paths, MPY_SAFE_MODE=1 and NO
     MPY_REAL_PORT, as the leader of a NEW process group (start_new_session) with stdin closed, polled with a hard timeout
     (default 180 s, at most 300 s). The in-host runner (out/vscode-tests/index.js) writes results.json and VS Code quits by itself.
  4. Whatever happens (exit, timeout, exception, Ctrl-C) the process group gets SIGTERM, 5 s of grace, then SIGKILL; then every
     process still mentioning the run directory is killed too (the bridge starts in a group of its own), `ps` is checked, the
     logs and results are copied to tools/vscode_test/reports/<id>/ and the scratch directory is removed (--keep-run-dir keeps it).
  5. Exit code: 0 all passed, 1 test or check failures, 2 hard timeout / blocked, 3 harness error.

Never opens a real serial port: the only board is the fake one; MPY_REAL_PORT is removed from the child environment and a
run refuses to start when VS Code or anything from /tmp/mpyvs is already running.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"
SCRATCH_BASE = Path(os.environ.get("MPYVS_BASE", r"C:\mpyvs" if IS_WIN else "/tmp/mpyvs"))
REPORTS = REPO / "tools" / "vscode_test" / "reports"
TESTS_ENTRY = REPO / "out" / "vscode-tests" / "index.js"
OLD_VSIX = REPO.parent / "mpy-workbench" / "mpy-workbench-0.3.2.vsix"
REAL_EXT_DIR = Path.home() / ".vscode" / "extensions"
REAL_PORT_GUARD = "/dev/cu.usbserial-0001"  # only ever passed to lsof (read-only), never opened

SUITES = ("smoke", "activation", "views", "flow", "all", "python", "coexist", "exitprobe", "intellisense", "intellisense-spikes", "intellisense-all")
FIXTURES = REPO / "test" / "fixtures" / "intellisense"
PYTHON_EXT_PATTERNS = (
    r"^ms-python\.python-\d",
    r"^ms-python\.vscode-pylance-\d",
    r"^ms-python\.vscode-python-envs-\d",
)
OLD_EXT_ID = "DanielBucam.mpy-workbench"
OLD_EXT_DIR = "danielbucam.mpy-workbench-0.3.2"
OUR_EXT_ID = "jpswensen.upython-bridge"
TERMINAL_NAME = "\u03bcPython Bridge"  # U+03BC GREEK SMALL LETTER MU (never the micro sign U+00B5), src/identity.ts


def vscode_binary() -> Path:
    if IS_WIN:
        return Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Microsoft VS Code" / "Code.exe"
    return Path("/Applications/Visual Studio Code.app/Contents/MacOS/Code")


# ---------------------------------------------------------------------------------------------------------- processes

def ps_table() -> List[Tuple[int, int, int, str]]:
    """(pid, pgid, ppid, command) of every process."""
    if IS_WIN:
        return []
    out = subprocess.run(["ps", "-axo", "pid=,pgid=,ppid=,command="], capture_output=True, text=True, timeout=20).stdout
    rows = []
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$", line)
        if m:
            rows.append((int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)))
    return rows


# A scratch run directory looks like /tmp/mpyvs/<suite>-<HHMMSS>. Matching this (not the bare word "mpyvs") keeps the
# orchestrator's own watchdog, whose command line quotes "/tmp/mpyvs", out of every check and every kill.
SCRATCH_RX = re.compile(r"mpyvs[\\/][A-Za-z]+-\d{6}")


def processes_mentioning(needle: str) -> List[Tuple[int, int, int, str]]:
    """Processes whose command line contains `needle`, except this launcher and its ancestors (a shell may quote our own command line)."""
    table = ps_table()
    parent = {pid: ppid for pid, _g, ppid, _c in table}
    skip = set()
    pid = os.getpid()
    while pid and pid not in skip:
        skip.add(pid)
        pid = parent.get(pid, 0)
    return [r for r in table if (SCRATCH_RX.search(r[3]) if needle == "mpyvs" else needle in r[3]) and r[0] not in skip]


def kill_pid_tree(pid: int, grace: float = 5.0) -> None:
    """SIGTERM, wait up to `grace`, SIGKILL (a single pid; POSIX only)."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return
        except PermissionError:
            return
        end = time.time() + (grace if sig == signal.SIGTERM else 2.0)
        while time.time() < end:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)


def kill_group(proc: "subprocess.Popen[bytes]", grace: float = 5.0) -> str:
    """Process-group kill: SIGTERM, 5 s, SIGKILL. Returns what was needed."""
    if IS_WIN:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=30)
        return "taskkill"
    try:
        pgid = os.getpgid(proc.pid)
    except ProcessLookupError:
        pgid = proc.pid
    used = "none (already gone)"

    def group_alive() -> bool:
        try:
            os.killpg(pgid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    if group_alive():
        used = "SIGTERM"
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        end = time.time() + grace
        while time.time() < end and group_alive():
            time.sleep(0.1)
        if group_alive():
            used = "SIGTERM then SIGKILL"
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            time.sleep(0.5)
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    return used


# ------------------------------------------------------------------------------------------------ real-profile guard

def _stat_sig(p: Path) -> Optional[Tuple[int, int]]:
    try:
        st = p.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def fingerprint() -> Dict[str, Any]:
    """mtime/size of files in the instructor's real profile and a shallow listing of places VS Code may touch."""
    home = Path.home()
    singles = [
        home / "Library/Application Support/Code/User/settings.json",
        home / "Library/Application Support/Code/User/keybindings.json",
        home / "Library/Application Support/Code/User/globalStorage/storage.json",
        home / "Library/Application Support/Code/User/globalStorage/state.vscdb",
        home / ".vscode/extensions/extensions.json",
        home / ".vscode/argv.json",
    ]
    out: Dict[str, Any] = {"files": {str(p): _stat_sig(p) for p in singles}}
    listings: Dict[str, Any] = {}

    def shallow(base: Path, depth: int, name_filter: Optional[str] = None) -> Dict[str, Any]:
        res: Dict[str, Any] = {}
        if not base.exists():
            return res
        stack = [(base, 0)]
        while stack:
            d, level = stack.pop()
            try:
                entries = list(os.scandir(d))
            except OSError:
                continue
            for e in entries:
                if name_filter and level == 0 and not re.search(name_filter, e.name, re.I):
                    continue
                try:
                    res[e.path] = e.stat(follow_symlinks=False).st_mtime_ns
                except OSError:
                    continue
                if e.is_dir(follow_symlinks=False) and level + 1 < depth:
                    stack.append((Path(e.path), level + 1))
        return res

    listings["Application Support/Code"] = shallow(home / "Library/Application Support/Code", 2)
    listings[".vscode"] = shallow(home / ".vscode", 1)
    listings["Saved Application State"] = shallow(home / "Library/Saved Application State", 2, r"vscode")
    listings["Preferences"] = shallow(home / "Library/Preferences", 1, r"vscode")
    listings["Caches"] = shallow(home / "Library/Caches", 1, r"vscode|microsoft\.vs")
    listings["/tmp (VS Code related names)"] = shallow(Path("/tmp"), 1, r"vscode|electron|code|\.sock") if not IS_WIN else {}
    out["listings"] = listings
    return out


def diff_fingerprint(before: Dict[str, Any], after: Dict[str, Any]) -> List[str]:
    changes: List[str] = []
    for k, v in before["files"].items():
        if after["files"].get(k) != v:
            changes.append(f"file changed: {k} {v} -> {after['files'].get(k)}")
    for name, b in before["listings"].items():
        a = after["listings"].get(name, {})
        for p in sorted(set(a) | set(b)):
            if "/mpyvs" in p:
                continue  # our own scratch root
            if a.get(p) != b.get(p):
                changes.append(f"{name}: {p} {'added' if p not in b else 'removed' if p not in a else 'modified'}")
    return changes


def lsof_real_port() -> str:
    if IS_WIN or not Path(REAL_PORT_GUARD).exists():
        return "(real port not present or Windows)"
    try:
        r = subprocess.run(["lsof", REAL_PORT_GUARD], capture_output=True, text=True, timeout=15)
        return (r.stdout + r.stderr).strip() or "(empty: nothing holds the real port)"
    except Exception as e:  # noqa: BLE001 - evidence only
        return f"(lsof failed: {e})"


# --------------------------------------------------------------------------------------------- scratch directory build

def version_key(name: str) -> Tuple[int, ...]:
    m = re.search(r"-(\d+(?:\.\d+)*)", name)
    return tuple(int(x) for x in m.group(1).split(".")) if m else (0,)


def newest_extension(pattern: str) -> Optional[Path]:
    rx = re.compile(pattern)
    cands = [p for p in REAL_EXT_DIR.iterdir() if p.is_dir() and rx.search(p.name)] if REAL_EXT_DIR.is_dir() else []
    return max(cands, key=lambda p: version_key(p.name)) if cands else None


def copy_python_extensions(ext_dir: Path, registry: List[Dict[str, Any]]) -> List[str]:
    """Copy (never symlink) the newest ms-python.python / pylance / python-envs folders and register them."""
    real_registry: List[Dict[str, Any]] = []
    try:
        real_registry = json.loads((REAL_EXT_DIR / "extensions.json").read_text(encoding="utf8"))
    except (OSError, ValueError):
        pass
    copied: List[str] = []
    for pattern in PYTHON_EXT_PATTERNS:
        src = newest_extension(pattern)
        if src is None:
            raise RuntimeError(f"extension matching {pattern} not found in {REAL_EXT_DIR}")
        dest = ext_dir / src.name
        shutil.copytree(src, dest, symlinks=True)
        copied.append(src.name)
        entry = next((e for e in real_registry if e.get("relativeLocation") == src.name), None)
        if entry is None:
            pkg = json.loads((src / "package.json").read_text(encoding="utf8"))
            entry = {
                "identifier": {"id": f"{pkg['publisher']}.{pkg['name']}"}, "version": pkg["version"],
                "metadata": {"isApplicationScoped": False, "isMachineScoped": False, "isBuiltin": False,
                             "installedTimestamp": int(time.time() * 1000), "pinned": False, "source": "gallery"},
            }
        entry = json.loads(json.dumps(entry))
        entry["location"] = {"$mid": 1, "path": str(dest), "scheme": "file"}
        entry["relativeLocation"] = src.name
        registry.append(entry)
    return copied


def extract_old_extension(ext_dir: Path, registry: List[Dict[str, Any]]) -> str:
    """Unzip `extension/` of the old VSIX into ext/<publisher.name-version>/ (zip-slip safe)."""
    if not OLD_VSIX.is_file():
        raise RuntimeError(f"old extension VSIX not found: {OLD_VSIX}")
    dest = ext_dir / OLD_EXT_DIR
    dest.mkdir(parents=True)
    with zipfile.ZipFile(OLD_VSIX) as z:
        for info in z.infolist():
            if not info.filename.startswith("extension/") or info.filename.endswith("/"):
                continue
            rel = info.filename[len("extension/"):]
            target = (dest / rel).resolve()
            if dest.resolve() not in target.parents:
                raise RuntimeError(f"unsafe path in VSIX: {info.filename}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
    pkg = json.loads((dest / "package.json").read_text(encoding="utf8"))
    registry.append({
        "identifier": {"id": OLD_EXT_ID}, "version": pkg["version"],
        "location": {"$mid": 1, "path": str(dest), "scheme": "file"}, "relativeLocation": OLD_EXT_DIR,
        "metadata": {"isApplicationScoped": False, "isMachineScoped": False, "isBuiltin": False,
                     "installedTimestamp": int(time.time() * 1000), "pinned": False, "source": "vsix"},
    })
    return OLD_EXT_DIR


SAMPLE_FILES: Dict[str, str] = {
    "hello world (1).py": 'import sys\nprint("hello from the board")\nprint("caf\u00e9 \u2713")\n',
    "loop prog.py": 'import time\nwhile True:\n    print("tick")\n    time.sleep(0.1)\n',
    "error prog.py": 'print("before the error")\nx = 1\nraise ValueError("boom")\n',
    "main.py": 'print("main program")\n',
    "lib/helper (v2).py": "VALUE = 42\n",
}
MARKER_FILES = ("main.py", ".mpyignore")


def is_intellisense(suite: str) -> bool:
    return suite.startswith("intellisense")


def write_acme(ws: Path) -> None:
    """The made-up "acme" project of the IntelliSense suites: student files and the student's own lib/acme_extra.py (a local
    module always wins over the board's frozen acme_extra; it is in lib/, not typings/, because the fallback-tier spike needs a
    workspace without typings/). The custom modules live ON THE (fake) BOARD (acme_board_profile); no firmware folder anywhere."""
    shutil.copy(FIXTURES / "student-board" / "main.py", ws / "student.py")
    shutil.copy(FIXTURES / "student-board" / "wrong.py", ws / "wrong.py")
    (ws / "lib").mkdir(exist_ok=True)
    (ws / "lib" / "acme_extra.py").write_text("def extra_local() -> int:\n    return 1\n", encoding="utf8")
    (ws / "bad.py").write_text("import module_nobody_has\n", encoding="utf8")


def acme_board_profile() -> Dict[str, Any]:
    """A fake board with custom firmware for the IntelliSense suites: frozen package `acme` (motor, pins, extra), frozen
    `acme_extra`, C module `_acme`, and /lib/helper.py on its file system (test/fixtures/intellisense/fake-board-acme)."""
    from tools.fakeboard import derive_profile  # noqa: PLC0415 - needs REPO on sys.path

    src = FIXTURES / "fake-board-acme"
    def read_tree(sub: str) -> Dict[str, str]:
        base = src / sub
        return {p.relative_to(base).as_posix(): p.read_text(encoding="utf8") for p in sorted(base.rglob("*.py"))}
    c_modules = {name[:-3]: text for name, text in read_tree("c_modules").items()}
    return derive_profile("custom-frozen", "acme-intellisense", frozen=dict(read_tree("frozen"), __replace__=True),
                          c_modules=dict(c_modules, __replace__=True), root_files=read_tree("files"))


def write_workspace(ws: Path, board_url: str, python: str, *, markers: bool, python_suite: bool, create_venv: bool, intellisense: bool = False) -> Dict[str, str]:
    ws.mkdir(parents=True)
    for rel, text in SAMPLE_FILES.items():
        if not markers and rel in MARKER_FILES:
            continue
        p = ws / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf8")
    if markers:
        (ws / ".mpyignore").write_text("# files the course does not copy to the board\n*.log\nnotes/\n", encoding="utf8")
    settings: Dict[str, Any] = {
        "upy-bridge.port": board_url,
        "upy-bridge.autoSync": "off",
        "upy-bridge.pythonPath": python,
        "upy-bridge.logLevel": "debug",
        "python.terminal.activateEnvironment": bool(python_suite),
        "window.confirmBeforeClose": "never",
    }
    if python_suite:
        settings["python-envs.terminal.autoActivationType"] = "command"
    if intellisense:
        settings["python.analysis.logLevel"] = "Trace"  # the language server log then names the config files, extra paths and stub path it used
    (ws / ".vscode").mkdir()
    (ws / ".vscode" / "settings.json").write_text(json.dumps(settings, indent=2) + "\n", encoding="utf8")
    if intellisense:
        write_acme(ws)
    if create_venv:
        subprocess.run([python, "-m", "venv", str(ws / ".venv")], check=True, capture_output=True, timeout=120)
    return {rel: str(ws / rel) for rel in SAMPLE_FILES if markers or rel not in MARKER_FILES}


USER_SETTINGS: Dict[str, Any] = {
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoUpdate": False,
    "extensions.autoCheckUpdates": False,
    "workbench.startupEditor": "none",
    "workbench.enableExperiments": False,
    "workbench.tips.enabled": False,
    "security.workspace.trust.enabled": False,
    "window.restoreWindows": "none",
    "window.confirmBeforeClose": "never",
    "files.hotExit": "off",
    "terminal.integrated.enablePersistentSessions": False,
    "chat.disableAIFeatures": True,
    "git.enabled": False,
}


def build_scratch(run_id: str, args: argparse.Namespace, board_url: str, python: str) -> Dict[str, Any]:
    root = SCRATCH_BASE / run_id
    # VSCODE_PORTABLE (see main()) makes VS Code use <portable>/user-data and ignore --user-data-dir, so the profile lives there.
    dirs = {name: root / name for name in ("portable", "ext", "ws", "out", "board")}
    dirs["ud"] = dirs["portable"] / "user-data"
    for name, d in dirs.items():
        if name != "ws":
            d.mkdir(parents=True, exist_ok=True)
    (dirs["ud"] / "User").mkdir()
    (dirs["ud"] / "User" / "settings.json").write_text(json.dumps(USER_SETTINGS, indent=2) + "\n", encoding="utf8")
    registry: List[Dict[str, Any]] = []
    copied: List[str] = []
    if args.with_python_extensions:
        copied += copy_python_extensions(dirs["ext"], registry)
    if args.with_old_extension:
        copied.append(extract_old_extension(dirs["ext"], registry))
    if registry:
        (dirs["ext"] / "extensions.json").write_text(json.dumps(registry), encoding="utf8")
    markers = args.suite in ("python", "coexist") or is_intellisense(args.suite) or args.markers
    ws = dirs["ws"] / "OneDrive-Example University(mail.example.edu)" / "Course (Fall)" / "Lab 1 \u2013 caf\u00e9"
    files = write_workspace(ws, board_url, python, markers=markers, python_suite=args.with_python_extensions,
                            create_venv=args.with_python_extensions, intellisense=is_intellisense(args.suite))
    return {"root": root, "dirs": dirs, "ws": ws, "files": files, "copied": copied, "markers": markers}


# ----------------------------------------------------------------------------------------------------- launch + checks

def collect_logs(ud: Path, dest: Path, cap: int = 2_000_000) -> List[str]:
    copied: List[str] = []
    logs = ud / "logs"
    if not logs.is_dir():
        return copied
    for p in logs.rglob("*"):
        if p.is_file() and p.suffix in (".log", ".txt", ".json"):
            rel = p.relative_to(logs)
            target = dest / "logs" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            data = p.read_bytes()
            if len(data) > cap:
                data = data[:cap // 2] + b"\n...[truncated by launcher]...\n" + data[-cap // 2:]
            target.write_bytes(data)
            copied.append(str(rel))
    return copied


def read_log(dest: Path, name_re: str) -> List[Tuple[str, str]]:
    out = []
    for p in sorted((dest / "logs").rglob("*")) if (dest / "logs").is_dir() else []:
        if p.is_file() and re.search(name_re, str(p.relative_to(dest / "logs")), re.I):
            out.append((str(p.relative_to(dest / "logs")), p.read_text(encoding="utf8", errors="replace")))
    return out


def analyze(suite: str, args: argparse.Namespace, dest: Path, results: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    checks: List[Dict[str, Any]] = []

    def add(name: str, ok: bool, detail: str) -> None:
        checks.append({"name": name, "ok": ok, "detail": detail})

    exthost = read_log(dest, r"exthost[\\/]exthost\.log$")
    add("extension-host log copied", bool(exthost), ", ".join(n for n, _ in exthost) or "no exthost.log found under logs/")
    if suite == "smoke":
        return checks
    ours = re.compile(r"upython-bridge|upy-bridge|\u03bcpython bridge", re.I)
    errors = [f"{n}: {line.strip()}" for n, text in exthost for line in text.splitlines()
              if re.search(r"\[(error|critical)\]", line) and ours.search(line)]
    add("no error entries from our extension in the extension-host log", not errors, "; ".join(errors[:5]) or "none")
    dup = [f"{n}: {line.strip()}" for n, text in exthost for line in text.splitlines()
           if re.search(r"already (exists|registered)|duplicate (command|registration|view)", line, re.I)]
    add("no duplicate-registration messages in the extension-host log", not dup, "; ".join(dup[:5]) or "none")
    if suite == "python":
        mine = re.compile(re.escape(TERMINAL_NAME) + "|sendText|send text", re.I)
        found: Dict[str, List[str]] = {}
        for n, text in read_log(dest, r"python|envs"):
            lines = [ln.strip()[:300] for ln in text.splitlines() if mine.search(ln)]
            if lines:
                found[n] = lines[:12]
        # evidence only: the authoritative check is the in-host record of everything the terminal received
        add("Python/Envs logs: lines about terminals (evidence; see s05-python-logs.json)", True, f"{sum(len(v) for v in found.values())} lines in {len(found)} logs")
        (dest / "s05-python-logs.json").write_text(json.dumps(found, indent=2), encoding="utf8")
    if is_intellisense(suite):
        # evidence for S-04: what the language server says about the config files, extra paths and stub path it used
        wanted = re.compile(r"config|extends|extraPaths|extra paths|stubPath|stub path|search paths|ignore|python platform|\.upy-bridge|typings", re.I)
        picked: Dict[str, List[str]] = {}
        for n, text in read_log(dest, r"pylance|language server|python"):
            lines = [ln.strip()[:400] for ln in text.splitlines() if wanted.search(ln)]
            if lines:
                picked[n] = lines[:200]
        (dest / "s04-pylance-log.json").write_text(json.dumps(picked, indent=1), encoding="utf8")
        add("Pylance logs: lines about config, extra paths and stub path (evidence; see s04-pylance-log.json)", True,
            f"{sum(len(v) for v in picked.values())} lines in {len(picked)} logs")
    if suite == "coexist":
        loaded = [f"{n}" for n, text in exthost if OLD_EXT_DIR.split("-")[0] in text.lower() or "mpy-workbench" in text.lower()]
        add("old extension named in the extension-host log (evidence)", True, ", ".join(loaded) or "not named (not an error)")
    return checks


class PsSampler:
    """Samples `ps` every ~60 ms for processes of THIS run (pid, ppid, pgid, state) so the order of deaths at window close is evidence."""

    def __init__(self, needle: str) -> None:
        import threading  # noqa: PLC0415

        self.needle = needle
        self.samples: List[Dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def _loop(self) -> None:
        t0 = time.time()
        last = None
        while not self._stop.is_set():
            try:
                out = subprocess.run(["ps", "-axo", "pid=,ppid=,pgid=,stat=,command="], capture_output=True, text=True, timeout=10).stdout
                rows = []
                for line in out.splitlines():
                    if self.needle in line and "ps -axo" not in line:
                        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$", line)
                        if m:
                            kind = "bridge" if "mpy_bridge.py" in m.group(5) else ("helper" if "Helper" in m.group(5) else "main" if m.group(5).startswith(str(vscode_binary())) else "other")
                            rows.append((int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4), kind))
                key = sorted(rows)
                if key != last:
                    self.samples.append({"t": round(time.time() - t0, 3), "procs": [list(r) for r in key]})
                    last = key
            except Exception:  # noqa: BLE001 - diagnostics only
                pass
            self._stop.wait(0.05)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> List[Dict[str, Any]]:
        self._stop.set()
        self._thread.join(5)
        return self.samples


def run_vscode(argv: List[str], env: Dict[str, str], out_dir: Path, timeout: float, sampler: Optional[PsSampler] = None) -> Dict[str, Any]:
    info: Dict[str, Any] = {"timedOut": False, "exitCode": None, "killed": None, "seconds": 0.0, "exception": None}
    if sampler is not None:
        sampler.start()
    log = open(out_dir / "vscode-stdout-stderr.log", "wb")
    started = time.time()
    proc: Optional["subprocess.Popen[bytes]"] = None
    try:
        proc = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=not IS_WIN, creationflags=(0x00000200 if IS_WIN else 0))
        info["pid"] = proc.pid
        while True:
            code = proc.poll()
            if code is not None:
                info["exitCode"] = code
                break
            if time.time() - started > timeout:
                info["timedOut"] = True
                break
            time.sleep(0.25)
    except BaseException as e:  # noqa: BLE001 - includes KeyboardInterrupt; the finally block still cleans up
        info["exception"] = f"{type(e).__name__}: {e}"
        raise
    finally:
        info["seconds"] = round(time.time() - started, 1)
        if proc is not None:
            info["killed"] = kill_group(proc)
        log.close()
    return info


def residual_processes(needle: str) -> List[str]:
    return [f"pid {p} pgid {g}: {c[:200]}" for p, g, _pp, c in processes_mentioning(needle)]


def kill_residuals(needle: str) -> Tuple[List[str], List[str]]:
    """Processes that outlived VS Code (the bridge runs in a group of its own). Returns (found, still_alive_after_kill)."""
    found = residual_processes(needle)
    for p, _g, _pp, _c in processes_mentioning(needle):
        kill_pid_tree(p)
    time.sleep(0.5)
    return found, residual_processes(needle)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--suite", required=True, choices=SUITES)
    ap.add_argument("--timeout", type=float, default=None, help="hard timeout in seconds (max 300; default 180, and 300 for the intellisense suites: real Pylance needs about 155 s for all of them)")
    ap.add_argument("--with-python-extensions", action="store_true")
    ap.add_argument("--with-old-extension", action="store_true")
    ap.add_argument("--keep-run-dir", action="store_true")
    ap.add_argument("--markers", action="store_true", help="put main.py/.mpyignore in the workspace (always on for python/coexist)")
    ap.add_argument("--activate-via", choices=("view", "command"), default="view", help="how the activation suite first activates the extension")
    ap.add_argument("--quit-via", choices=("command", "test-exit"), default="command",
                    help="how the window ends: 'command' = workbench.action.quit after the results are written (the student's way), "
                         "'test-exit' = run() simply returns (VS Code's test-mode exit)")
    ap.add_argument("--extra-arg", action="append", default=[], help="extra VS Code argument, as --extra-arg=--disable-gpu")
    ap.add_argument("--bridge-trace", action="store_true",
                    help="like --bridge-stderr-log, and the wrapper also logs how the Python bridge ended (status, signals) to bridge-trace.log")
    ap.add_argument("--bridge-stderr-log", action="store_true",
                    help="diagnostic: run the bridge through a tiny wrapper that also copies its stderr to a file (survives the host)")
    ap.add_argument("--dry-run", action="store_true", help="build the scratch directory and the fake board, print the command, do NOT launch VS Code")
    args = ap.parse_args(argv)
    if args.timeout is None:
        args.timeout = 300.0 if is_intellisense(args.suite) else 180.0
    args.timeout = max(10.0, min(args.timeout, 300.0))
    if is_intellisense(args.suite):
        args.with_python_extensions = True  # these suites are about the REAL Pylance; they make no sense without it

    code_bin = vscode_binary()
    if not args.dry_run and not code_bin.exists():
        print(f"VS Code not found at {code_bin}", file=sys.stderr)
        return 3
    if not TESTS_ENTRY.exists() and not args.dry_run:
        print(f"{TESTS_ENTRY} is missing: run `node scripts/build-vscode-tests.mjs` first", file=sys.stderr)
        return 3
    if not args.dry_run:
        busy = [c for _p, _g, _pp, c in processes_mentioning("mpyvs")]
        if busy:
            print("refusing to start: something from /tmp/mpyvs is already running:\n  " + "\n  ".join(busy[:5]), file=sys.stderr)
            return 3
        running = [c for _p, _g, _pp, c in ps_table() if c.startswith(str(code_bin)) and "mpyvs" not in c]
        if running:
            print("note: another VS Code is open (the instructor's, never touched); using a separate profile.", file=sys.stderr)

    run_id = f"{args.suite[:5]}-{time.strftime('%H%M%S')}"
    report_dir = REPORTS / run_id
    report_dir.mkdir(parents=True, exist_ok=True)
    python = os.path.realpath(sys.executable) if os.path.isabs(sys.executable) else shutil.which("python3.13") or sys.executable
    summary: Dict[str, Any] = {"runId": run_id, "suite": args.suite, "args": vars(args), "python": python,
                               "startedAt": time.strftime("%Y-%m-%d %H:%M:%S")}
    exit_code = 3
    scratch: Optional[Dict[str, Any]] = None
    board: Any = None
    fp_before = fingerprint()
    summary["realPortLsofBefore"] = lsof_real_port()

    try:
        from tools.fakeboard import FakeBoard  # noqa: PLC0415 - needs REPO on sys.path

        run_root = SCRATCH_BASE / run_id
        board_root = run_root / "board"
        board_root.mkdir(parents=True)  # the device '/' of the fake board is a folder inside the scratch root
        board = FakeBoard(profile=acme_board_profile() if is_intellisense(args.suite) else "esp32", root=str(board_root), seed=True, exclusive=True)
        board.start()
        scratch = build_scratch(run_id, args, board.url, python)
        if (args.bridge_stderr_log or args.bridge_trace) and not IS_WIN:
            wrapper = scratch["root"] / "pywrap.sh"
            out_log = f'{scratch["root"]}/out/bridge-stderr.log'
            if args.bridge_trace:
                # Diagnosis of "who ended the bridge, and how": the wrapper stays the parent, so it can say with which status
                # (128 + n = signal n) the Python bridge ended, and which signals the wrapper itself received.
                trace = f'{scratch["root"]}/out/bridge-trace.log'
                wrapper.write_text(
                    "#!/bin/sh\n"
                    f'T="{trace}"\n'
                    'echo "wrapper start pid $$ ppid $PPID args: $1 $2 $3 $(date +%H:%M:%S)" >> "$T"\n'
                    'trap \'echo "wrapper got TERM $(date +%H:%M:%S)" >> "$T"\' TERM\n'
                    'trap \'echo "wrapper got HUP $(date +%H:%M:%S)" >> "$T"\' HUP\n'
                    'trap \'echo "wrapper got INT $(date +%H:%M:%S)" >> "$T"\' INT\n'
                    f'"{python}" "$@" 2>>"{out_log}"\n'
                    'rc=$?\n'
                    'echo "python ended with status $rc at $(date +%H:%M:%S) (128+n means killed by signal n)" >> "$T"\n'
                    'exit $rc\n',
                    encoding="utf8")
            else:
                wrapper.write_text(f'#!/bin/sh\nexec "{python}" "$@" 2>>"{out_log}"\n', encoding="utf8")
            wrapper.chmod(0o755)
            settings_path = scratch["ws"] / ".vscode" / "settings.json"
            cfg = json.loads(settings_path.read_text(encoding="utf8"))
            cfg["upy-bridge.pythonPath"] = str(wrapper)
            settings_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf8")
        # Seed the board's filesystem (device '/') with files that have awkward names.
        for rel, text in (("hello world (1).py", SAMPLE_FILES["hello world (1).py"]),
                          ("loop prog.py", SAMPLE_FILES["loop prog.py"]),
                          ("lib/helper (v2).py", SAMPLE_FILES["lib/helper (v2).py"]),
                          ("data/notes.txt", "notes on the board\n")):
            board.write_file("/" + rel, text.encode("utf8"))
        summary["boardUrl"] = board.url
        summary["boardRoot"] = str(board.root_str)
        dirs = scratch["dirs"]
        ws: Path = scratch["ws"]

        argv_vs = [
            str(code_bin),
            f"--user-data-dir={dirs['ud']}",
            f"--extensions-dir={dirs['ext']}",
            f"--extensionDevelopmentPath={REPO}",
            f"--extensionTestsPath={TESTS_ENTRY}",
            "--disable-workspace-trust", "--disable-updates", "--skip-welcome", "--skip-release-notes", "--disable-telemetry",
            *args.extra_arg,
            str(ws),
        ]
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("VSCODE_", "ELECTRON_")) and k not in ("MPY_REAL_PORT", "__CFBundleIdentifier")}
        env.update({
            # Portable mode (the folder exists) moves argv.json, which VS Code rewrites at every start, from ~/.vscode into the
            # scratch root: smoke run 1 showed ~/.vscode/argv.json being touched by an otherwise isolated launch.
            "VSCODE_PORTABLE": str(dirs["portable"]),
            "MPY_SAFE_MODE": "1",
            **({"MPY_BRIDGE_DEBUG": "1"} if (args.bridge_stderr_log or args.bridge_trace) else {}),
            "UPYBRIDGE_TEST": "1",
            "UPYBRIDGE_TEST_OUT": str(dirs["out"] / "results.json"),
            "UPYBRIDGE_TEST_SUITE": args.suite,
            "UPYBRIDGE_TEST_WS": str(ws),
            "UPYBRIDGE_TEST_BOARD_URL": board.url,
            "UPYBRIDGE_TEST_BOARD_ROOT": str(board.root_str),
            "UPYBRIDGE_TEST_UD": str(dirs["ud"]),
            "UPYBRIDGE_TEST_RUN_ROOT": str(scratch["root"]),
            "UPYBRIDGE_TEST_ACTIVATE_VIA": args.activate_via,
            "UPYBRIDGE_TEST_QUIT": "command" if args.quit_via == "command" else "",
            "UPYBRIDGE_TEST_GUARD_MS": str(int(max(20.0, args.timeout - 30.0) * 1000)),
        })
        summary["argv"] = argv_vs
        summary["copiedExtensions"] = scratch["copied"]
        print(f"[launch] run {run_id}: suite={args.suite} timeout={args.timeout:.0f}s board={board.url}")
        print("[launch] " + " ".join(f'"{a}"' if " " in a else a for a in argv_vs))
        if args.dry_run:
            print("[launch] --dry-run: not launching VS Code")
            summary["dryRun"] = True
            exit_code = 0
        else:
            sampler = PsSampler(f"mpyvs/{run_id}")
            info = run_vscode(argv_vs, env, dirs["out"], args.timeout, sampler)
            time.sleep(1.2)
            (report_dir / "ps-timeline.json").write_text(json.dumps(sampler.stop(), indent=0), encoding="utf8")
            summary["vscode"] = info
            print(f"[launch] VS Code ended: {info}")
            time.sleep(1.0)
            summary["residualsAfterExit"] = residual_processes(f"mpyvs/{run_id}")
            found, still = kill_residuals(f"mpyvs/{run_id}")
            summary["residualsKilled"] = found
            summary["residualsStillAlive"] = still
            if board is not None:
                end = time.time() + 5.0
                while board.program_running and time.time() < end:
                    time.sleep(0.1)
                summary["boardProgramRunningAfterExit"] = bool(board.program_running)
                summary["fakeboardEvents"] = len(board.events)
                (report_dir / "fakeboard-events.json").write_text(json.dumps(list(board.events), default=str, indent=1), encoding="utf8")
            results_path = dirs["out"] / "results.json"
            results = None
            if results_path.exists():
                shutil.copy(results_path, report_dir / "results.json")
                try:
                    results = json.loads(results_path.read_text(encoding="utf8"))
                except ValueError as e:
                    summary["resultsError"] = str(e)
            summary["logs"] = collect_logs(dirs["ud"], report_dir)
            shutil.copy(dirs["out"] / "vscode-stdout-stderr.log", report_dir / "vscode-stdout-stderr.log")
            for extra in ("bridge-stderr.log", "bridge-trace.log", "child-trace.log"):
                if (dirs["out"] / extra).exists():
                    shutil.copy(dirs["out"] / extra, report_dir / extra)
            checks = analyze(args.suite, args, report_dir, results)
            checks.append({"name": "no process mentioning the run directory survived VS Code's exit",
                           "ok": not summary["residualsAfterExit"],
                           "detail": "; ".join(summary["residualsAfterExit"][:3]) or "none"})
            if args.suite in ("flow", "all"):
                checks.append({"name": "no program is left running on the board after the window closed (stopOnDisconnect)",
                               "ok": not summary.get("boardProgramRunningAfterExit", False),
                               "detail": f"board.program_running after exit = {summary.get('boardProgramRunningAfterExit')}"})
            summary["checks"] = checks
            counts = (results or {}).get("counts", {})
            summary["counts"] = counts
            ok_results = bool(results) and results.get("ok") is True and counts.get("failed", 0) == 0 and counts.get("passed", 0) > 0
            ok_checks = all(c["ok"] for c in checks)
            if info["timedOut"]:
                exit_code = 2
            elif ok_results and ok_checks:
                exit_code = 0
            else:
                exit_code = 1
            summary["verdict"] = {"results": ok_results, "checks": ok_checks, "exitCode": exit_code}
    except BaseException as e:  # noqa: BLE001 - report, then fall through to the cleanup below
        summary["harnessError"] = f"{type(e).__name__}: {e}"
        print(f"[launch] harness error: {summary['harnessError']}", file=sys.stderr)
        exit_code = 3 if not isinstance(e, KeyboardInterrupt) else 130
    finally:
        try:
            if board is not None:
                try:
                    board.stop()
                except Exception as e:  # noqa: BLE001
                    summary["boardStopError"] = str(e)
            leftovers = residual_processes(f"mpyvs/{run_id}")
            if leftovers:
                kill_residuals(f"mpyvs/{run_id}")
            summary["psAfterCleanup"] = residual_processes("mpyvs")
            summary["realPortLsofAfter"] = lsof_real_port()
            summary["realProfileChanges"] = diff_fingerprint(fp_before, fingerprint())
            if scratch is not None and not args.keep_run_dir:
                shutil.rmtree(scratch["root"], ignore_errors=True)
                summary["scratchRemoved"] = not scratch["root"].exists()
            elif scratch is not None:
                summary["scratchKept"] = str(scratch["root"])
            (report_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf8")
        finally:
            pass
    print(f"[launch] exit {exit_code}; report: {report_dir}")
    for c in summary.get("checks", []):
        print(f"[check] {'ok  ' if c['ok'] else 'FAIL'} {c['name']}: {c['detail'][:200]}")
    if summary.get("counts"):
        print(f"[launch] in-host counts: {summary['counts']}")
    print(f"[launch] ps after cleanup mentioning mpyvs: {summary.get('psAfterCleanup')}")
    print(f"[launch] real profile changes: {summary.get('realProfileChanges')}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
