"""Marketplace screenshots of the extension in REAL VS Code, under the same isolation rules as launch.py (CLAUDE.md).

    python3.13 -B tools/vscode_test/screenshots.py [--with-python-extensions] [--timeout 300] [--keep-run-dir]

What it does, in order (and nothing else):
  1. refuses to start while anything from /tmp/mpyvs runs, and fingerprints the instructor's real VS Code profile;
  2. builds an ISOLATED profile under /tmp/mpyvs/<run>/ (portable user data + extensions dir; VSCODE_PORTABLE), a fake board
     (tools/fakeboard.py over socket://127.0.0.1, MPY_SAFE_MODE=1, never a serial port) with the made-up demo firmware of
     tools/vscode_test/demo/board, and a demo project folder from tools/vscode_test/demo/project;
  3. runs tools/vscode_test/screenshots.mjs (Playwright's Electron driver: it starts VS Code from the isolated profile,
     drives ONLY that window through the DevTools protocol, no OS-level input, no screen recording) as the leader of a new
     process group, under a hard timeout;
  4. kills the whole process group, kills anything left that mentions the run directory, re-checks the real-profile
     fingerprint (a change is reported, never ignored) and copies the PNGs to images/ (README.md shows them; the step log
     goes to tools/vscode_test/reports/<run>/).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import launch as L  # noqa: E402 - the launcher's guards are the policy; reused, not copied

DEMO = HERE / "demo"
SCRIPT = HERE / "screenshots.mjs"
OUT = L.REPO / "images"  # shown by README.md; served from the GitHub repository, not shipped in the VSIX (scripts/package.mjs)

SHOT_SETTINGS: Dict[str, Any] = {
    **L.USER_SETTINGS,
    "workbench.colorTheme": "Default Dark Modern",
    "window.dialogStyle": "custom",          # modal dialogs drawn by VS Code itself (part of the window, so in the screenshot)
    "window.titleBarStyle": "custom",
    "window.commandCenter": False,
    "workbench.layoutControl.enabled": False,
    "workbench.editor.showTabs": "multiple",
    "editor.minimap.enabled": False,
    "editor.fontSize": 14,
    "editor.renderWhitespace": "none",
    "breadcrumbs.enabled": False,
    "workbench.hover.delay": 200,
    "workbench.tree.indent": 14,
    "terminal.integrated.fontSize": 13,
    "explorer.openEditors.visible": 0,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "chat.commandCenter.enabled": False,
    "extensions.ignoreRecommendations": True,
    "workbench.welcomePage.walkthroughs.openOnInstall": False,
}


def demo_profile() -> Dict[str, Any]:
    from tools.fakeboard import derive_profile  # noqa: PLC0415

    def read_tree(sub: str, suffix: str = "") -> Dict[str, str]:
        base = DEMO / "board" / sub
        return {p.relative_to(base).as_posix(): p.read_text(encoding="utf8") for p in sorted(base.rglob("*" + suffix)) if p.is_file()}

    c_modules = {name[:-3]: text for name, text in read_tree("c_modules", ".py").items()}
    return derive_profile("esp32", "demo-rover", frozen=dict(read_tree("frozen", ".py"), __replace__=True),
                          c_modules=dict(c_modules, __replace__=True), caps={"clock_unset": True})


def install_vsix(vsix: Path, ext_dir: Path, registry: List[Dict[str, Any]]) -> str:
    """Install the built VSIX into the isolated extensions folder the way VS Code does (zip-slip safe), so the window looks like
    a normal install (no "[Extension Development Host]" title) and the production bundle is what is photographed."""
    import zipfile  # noqa: PLC0415

    with zipfile.ZipFile(vsix) as z:
        pkg = json.loads(z.read("extension/package.json"))
        folder = f"{pkg['publisher']}.{pkg['name']}-{pkg['version']}".lower()
        dest = ext_dir / folder
        dest.mkdir(parents=True)
        for info in z.infolist():
            if not info.filename.startswith("extension/") or info.filename.endswith("/"):
                continue
            target = (dest / info.filename[len("extension/"):]).resolve()
            if dest.resolve() not in target.parents:
                raise RuntimeError(f"unsafe path in VSIX: {info.filename}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
    registry.append({
        "identifier": {"id": f"{pkg['publisher']}.{pkg['name']}"}, "version": pkg["version"],
        "location": {"$mid": 1, "path": str(dest), "scheme": "file"}, "relativeLocation": folder,
        "metadata": {"isApplicationScoped": False, "isMachineScoped": False, "isBuiltin": False,
                     "installedTimestamp": int(time.time() * 1000), "pinned": False, "source": "vsix"},
    })
    return folder


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--with-python-extensions", action="store_true", help="copy Python/Pylance in (for the IntelliSense shot)")
    ap.add_argument("--timeout", type=float, default=300.0, help="hard timeout in seconds (max 420)")
    ap.add_argument("--keep-run-dir", action="store_true")
    ap.add_argument("--only", default="", help="comma-separated shot names (default: all)")
    ap.add_argument("--no-folder", action="store_true", help="open VS Code without a folder: the Open Folder welcome shot only")
    ap.add_argument("--details-check", action="store_true",
                    help="no folder; photograph the extension's details page (the README from the installed VSIX) into the report folder")
    args = ap.parse_args(argv)
    timeout = max(30.0, min(args.timeout, 420.0))

    code_bin = L.vscode_binary()
    if not code_bin.exists():
        print(f"VS Code not found at {code_bin}", file=sys.stderr)
        return 3
    busy = [c for _p, _g, _pp, c in L.processes_mentioning("mpyvs")]
    if busy:
        print("refusing to start: something from /tmp/mpyvs is already running:\n  " + "\n  ".join(busy[:5]), file=sys.stderr)
        return 3
    if not (L.REPO / "node_modules" / "playwright-core").exists():
        print("playwright-core is missing: npm install (it is a pinned devDependency)", file=sys.stderr)
        return 3

    run_id = f"shots-{time.strftime('%H%M%S')}"
    root = L.SCRATCH_BASE / run_id
    fp_before = L.fingerprint()
    board = None
    proc = None
    code = 3
    try:
        from tools.fakeboard import FakeBoard  # noqa: PLC0415

        dirs = {n: root / n for n in ("portable", "ext", "out", "board")}
        for d in dirs.values():
            d.mkdir(parents=True, exist_ok=True)
        ud = dirs["portable"] / "user-data"
        (ud / "User").mkdir(parents=True)
        (ud / "User" / "settings.json").write_text(json.dumps(SHOT_SETTINGS, indent=2) + "\n", encoding="utf8")
        registry: List[Dict[str, Any]] = []
        vsix = sorted((L.REPO / "out").glob("*.vsix"))
        if not vsix:
            print("no VSIX in out/: run npm run package (or npm run verify) first", file=sys.stderr)
            return 3
        install_vsix(vsix[-1], dirs["ext"], registry)
        if args.with_python_extensions:
            L.copy_python_extensions(dirs["ext"], registry)
        (dirs["ext"] / "extensions.json").write_text(json.dumps(registry), encoding="utf8")

        board = FakeBoard(profile=demo_profile(), root=str(dirs["board"]), seed=False, exclusive=True)
        board.start()
        for p in sorted((DEMO / "board" / "files").rglob("*")):
            if p.is_file():
                board.write_file("/" + p.relative_to(DEMO / "board" / "files").as_posix(), p.read_bytes())

        python = os.path.realpath(sys.executable)
        ws = root / "ws" / "Lab 3 - Line follower"
        shutil.copytree(DEMO / "project", ws)
        (ws / ".vscode").mkdir()
        (ws / ".vscode" / "settings.json").write_text(json.dumps({
            "upy-bridge.port": board.url, "upy-bridge.pythonPath": python, "window.confirmBeforeClose": "never",
        }, indent=2) + "\n", encoding="utf8")

        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("VSCODE_", "ELECTRON_")) and k not in ("MPY_REAL_PORT", "__CFBundleIdentifier")}
        env.update({"VSCODE_PORTABLE": str(dirs["portable"]), "MPY_SAFE_MODE": "1"})
        cfg = {
            "code": str(code_bin),
            "args": [f"--user-data-dir={ud}", f"--extensions-dir={dirs['ext']}",
                     "--disable-workspace-trust", "--disable-updates", "--skip-welcome", "--skip-release-notes", "--disable-telemetry",
                     *([] if args.no_folder or args.details_check else [str(ws)])],
            "noFolder": bool(args.no_folder), "details": bool(args.details_check),
            "env": env, "out": str(dirs["out"]), "boardRoot": str(board.root_str), "workspace": str(ws),
            "intellisense": bool(args.with_python_extensions), "only": [s for s in args.only.split(",") if s],
            "size": {"width": 1400, "height": 860},
        }
        cfg_path = root / "shots.json"
        cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf8")
        print(f"[shots] run {run_id}: board {board.url}, workspace {ws}")
        node = shutil.which("node") or "node"
        proc = subprocess.Popen([node, str(SCRIPT), str(cfg_path)], cwd=str(L.REPO), stdin=subprocess.DEVNULL,
                                start_new_session=True)
        started = time.time()
        while proc.poll() is None and time.time() - started < timeout:
            time.sleep(0.5)
        timed_out = proc.poll() is None
        how = L.kill_group(proc)
        code = 2 if timed_out else (proc.returncode or 0)
        print(f"[shots] driver ended: exit={proc.returncode} timedOut={timed_out} ({how})")
        time.sleep(1.0)
        found, still = L.kill_residuals(f"mpyvs/{run_id}")
        if found:
            print(f"[shots] killed leftovers: {found}; still alive: {still}")
        OUT.mkdir(parents=True, exist_ok=True)
        (L.REPORTS / run_id).mkdir(parents=True, exist_ok=True)
        shots = sorted(dirs["out"].glob("*.png"))
        for s in shots:
            shutil.copy(s, (L.REPORTS / run_id if s.name.startswith("check-") else OUT) / s.name)
        print(f"[shots] {len(shots)} screenshot(s): {[s.name for s in shots]} -> {OUT} (check-*.png -> {L.REPORTS / run_id})")
        if (dirs["out"] / "steps.log").exists():
            shutil.copy(dirs["out"] / "steps.log", L.REPORTS / run_id / "steps.log")
            print(f"[shots] step log: {L.REPORTS / run_id / 'steps.log'}")
    finally:
        if board is not None:
            try:
                board.stop()
            except Exception as e:  # noqa: BLE001
                print(f"[shots] board stop error: {e}", file=sys.stderr)
        changes = L.diff_fingerprint(fp_before, L.fingerprint())
        print(f"[shots] real profile changes: {changes}")
        left = [c for _p, _g, _pp, c in L.processes_mentioning(f"mpyvs/{run_id}")]
        print(f"[shots] ps after cleanup mentioning the run: {left}")
        if not args.keep_run_dir:
            shutil.rmtree(root, ignore_errors=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
