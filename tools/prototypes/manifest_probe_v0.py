#!/usr/bin/env python3
"""Evaluate a MicroPython manifest.py with the firmware tree's OWN tools/manifestfile.py
and print one JSON document describing what it would freeze.

Run as:  python -I manifest_probe.py '<json config>'

Why this approach (tier 1): manifest.py is real Python, so the only 100% faithful
evaluator is the one the firmware build uses.  We load manifestfile.py from the
firmware checkout (so the DSL version always matches the user's firmware), but wrap
every DSL call leniently: a failing require()/include()/freeze() is recorded in
"errors" and evaluation continues instead of losing everything after it.
"""
import importlib.util
import json
import os
import sys


def main():
    cfg = json.loads(sys.argv[1])
    spec = importlib.util.spec_from_file_location("manifestfile", cfg["manifestfile"])
    mf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mf)

    errors = []
    c_modules = []

    def lenient(name):
        def wrapper(self, *a, **k):
            try:
                return getattr(mf.ManifestFile, name)(self, *a, **k)
            except Exception as e:  # noqa: BLE001 - we want everything
                errors.append({"call": name, "args": [repr(x) for x in a][:3], "error": str(e)})
        return wrapper

    class Lenient(mf.ManifestFile):
        require = lenient("require")
        include = lenient("include")
        package = lenient("package")
        module = lenient("module")
        freeze = lenient("freeze")
        freeze_as_str = lenient("freeze_as_str")
        freeze_as_mpy = lenient("freeze_as_mpy")
        freeze_mpy = lenient("freeze_mpy")

        def _manifest_globals(self, kwargs):
            g = super()._manifest_globals(kwargs)
            # Older firmware trees (< ~1.27) have no c_module(); newer ones do.
            # Always provide a recording version so the manifest never aborts on it.
            def c_module(module_path):
                p = self._resolve_path(module_path)
                c_modules.append(p)
            g["c_module"] = c_module
            return g

    path_vars = {k: v for k, v in cfg["path_vars"].items() if v}
    m = Lenient(mf.MODE_FREEZE, path_vars)
    try:
        m.execute(cfg["manifest"])
    except Exception as e:  # noqa: BLE001
        errors.append({"call": "execute", "args": [cfg["manifest"]], "error": str(e)})

    files = []
    for f in m.files():
        full = os.path.normpath(f.full_path)
        target = os.path.normpath(f.target_path)
        root = full[: len(full) - len(target)].rstrip("\\/") if full.endswith(target) else os.path.dirname(full)
        files.append({"full_path": full, "target_path": target.replace("\\", "/"), "root": root})
    print(json.dumps({"files": files, "c_modules": c_modules, "errors": errors}))


if __name__ == "__main__":
    main()
