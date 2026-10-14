"""config.py - the optional ``--config`` JSON file (the only place where board- or course-specific facts live).

Schema (every key optional; unknown keys are REFUSED with a clear message, so a crafted config cannot smuggle options in)::

    {"backup_files": ["boot.py", "test.py"],              # downloaded to tools/hwtest/backup/<ts>/ before the first write
     "expect": {"impl": "micropython", "build": "ACME_BOARD", "version_min": [1, 29, 0]},
     "extra_probes": [{"name": "x", "code": "print('@@PROBE', __import__('_x').get_counts())", "before_after": true}],
     "scratch": "/_mpybench_test",                       # last folder name must start with _mpybench
     "shadow_names": ["acme", "_acme"],                    # names a file / program may not shadow or mention
     "probe_modules": ["_acme"],                           # modules a probe may import besides time and gc (default: the "_x"
                                                           #   entries of shadow_names; private C modules only, never a package)
     "allow_resets": 2,                                    # optional CAP on the chip reset budget of phase R; false/0 forbids it
     "notes": "free text copied into the report"}

``allow_resets`` can only LOWER what the command line allows, never raise it: phase R still needs ``--phases ...R``,
``--allow-resets N`` (1..5) and env MPY_ALLOW_RESETS=1; the effective budget is min(N, allow_resets).  Absent = no cap from the
config (the flags alone decide); ``false`` or ``0`` = the config forbids resets (exit 2); ``true`` = no cap; an integer 1..5 = cap.

``extra_probes[].code`` is device code, therefore it must pass ``confine.validate_probe_code`` (one ``print(...)`` of allowlisted
getter calls on ``time``, ``gc`` and ``probe_modules`` only; importing runs a module, so main/boot/test/_boot and every
``shadow_names`` package are refused; no resets, no I/O, no pins).  Errors are ``ConfigError`` with the file name and the offending key.
"""
from __future__ import annotations

import json
import os
import re

from tools.hwtest.confine import (ConfinementError, default_probe_modules, normalize_device_path, validate_probe_code,
                                  validate_probe_module, validate_scratch)

__all__ = ["Config", "ConfigError", "load_config", "DEFAULT_SCRATCH"]

DEFAULT_SCRATCH = "/_mpybench_test"
_KEYS = ("backup_files", "expect", "extra_probes", "scratch", "shadow_names", "probe_modules", "notes", "allow_resets")
_NAME_RE = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_PROBE_NAME_RE = re.compile(r"[A-Za-z0-9_.-]{1,40}")
_EXPECT_KEYS = ("impl", "build", "version_min")


class ConfigError(Exception):
    pass


class Config(object):
    def __init__(self, source=None, backup_files=(), expect=None, extra_probes=(), scratch=DEFAULT_SCRATCH, shadow_names=(),
                 notes="", probe_modules=None, allow_resets=None):
        self.source = source
        self.allow_resets = allow_resets          # None = no cap from the config; an int 0..5 = cap (0 forbids phase R)
        self.backup_files = list(backup_files)
        self.expect = dict(expect or {})
        self.extra_probes = list(extra_probes)
        self.scratch = scratch
        self.shadow_names = list(shadow_names)
        self.probe_modules = default_probe_modules(self.shadow_names) if probe_modules is None else list(probe_modules)
        self.notes = notes

    def as_dict(self):
        return {"source": self.source, "backup_files": self.backup_files, "expect": self.expect,
                "extra_probes": self.extra_probes, "scratch": self.scratch, "shadow_names": self.shadow_names,
                "probe_modules": self.probe_modules, "notes": self.notes, "allow_resets": self.allow_resets}


def load_config(path=None):
    """Load and validate ``path`` (None -> defaults).  Raises ConfigError."""
    if path is None:
        return Config()
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except OSError as exc:
        raise ConfigError("cannot read config %s: %s" % (path, exc))
    except ValueError as exc:
        raise ConfigError("config %s is not valid JSON: %s" % (path, exc))
    return validate_config(data, source=path)


def validate_config(data, source="<config>"):
    def bad(msg):
        raise ConfigError("config %s: %s" % (source, msg))

    if not isinstance(data, dict):
        bad("the top level must be an object")
    unknown = sorted(set(data) - set(_KEYS))
    if unknown:
        bad("unknown key(s) %s (allowed: %s)" % (", ".join(unknown), ", ".join(_KEYS)))
    cfg = Config(source=source)
    bf = data.get("backup_files", [])
    if not isinstance(bf, list) or not all(isinstance(x, str) and x for x in bf) or len(bf) > 20:
        bad("backup_files must be a list of up to 20 file names")
    names = []
    for x in bf:
        try:
            norm = normalize_device_path(x if x.startswith("/") else "/" + x)
        except ConfinementError as exc:
            bad("backup_files: %s" % exc)
        if norm == "/" or not norm.strip("/").replace("/", "__"):
            bad("backup_files: %r is the root folder, not a file" % (x,))
        names.append(norm)
    cfg.backup_files = names
    exp = data.get("expect", {})
    if not isinstance(exp, dict) or set(exp) - set(_EXPECT_KEYS):
        bad("expect must be an object with keys from %s" % ", ".join(_EXPECT_KEYS))
    for k in ("impl", "build"):
        if k in exp and not isinstance(exp[k], str):
            bad("expect.%s must be a string" % k)
    if "version_min" in exp:
        vm = exp["version_min"]
        if not (isinstance(vm, list) and len(vm) == 3 and all(isinstance(i, int) and not isinstance(i, bool) for i in vm)):
            bad("expect.version_min must be [major, minor, patch]")
    cfg.expect = exp
    sn = data.get("shadow_names", [])
    if not isinstance(sn, list) or not all(isinstance(x, str) and _NAME_RE.fullmatch(x) for x in sn) or len(sn) > 100:
        bad("shadow_names must be a list of module names")
    cfg.shadow_names = sn
    if "probe_modules" in data:
        pm = data["probe_modules"]
        if not isinstance(pm, list) or len(pm) > 20:
            bad("probe_modules must be a list of up to 20 module names")
        for m in pm:
            try:
                validate_probe_module(m, sn, pm)
            except ConfinementError as exc:
                bad("probe_modules: %s" % exc)
        cfg.probe_modules = list(pm)
    else:
        cfg.probe_modules = default_probe_modules(sn)
    probes = data.get("extra_probes", [])
    if not isinstance(probes, list) or len(probes) > 10:
        bad("extra_probes must be a list of up to 10 objects")
    clean = []
    for i, p in enumerate(probes):
        if not isinstance(p, dict) or set(p) - {"name", "code", "before_after"}:
            bad("extra_probes[%d] must be an object with name, code, before_after" % i)
        if not isinstance(p.get("name"), str) or not _PROBE_NAME_RE.fullmatch(p["name"]):
            bad("extra_probes[%d].name must match [A-Za-z0-9_.-]{1,40}" % i)
        try:
            validate_probe_code(p.get("code"), sn, cfg.probe_modules)
        except ConfinementError as exc:
            bad("extra_probes[%d] (%s): %s" % (i, p["name"], exc))
        ba = p.get("before_after", False)
        if not isinstance(ba, bool):
            bad("extra_probes[%d].before_after must be a boolean" % i)
        clean.append({"name": p["name"], "code": p["code"], "before_after": ba})
    cfg.extra_probes = clean
    try:
        cfg.scratch = validate_scratch(data.get("scratch", DEFAULT_SCRATCH))
    except ConfinementError as exc:
        bad("scratch: %s" % exc)
    notes = data.get("notes", "")
    if not isinstance(notes, str) or len(notes) > 4000:
        bad("notes must be a string of at most 4000 characters")
    cfg.notes = notes
    if "allow_resets" in data:
        ar = data["allow_resets"]
        if isinstance(ar, bool):
            cfg.allow_resets = None if ar else 0
        elif isinstance(ar, int) and 0 <= ar <= 5:
            cfg.allow_resets = ar
        else:
            bad("allow_resets must be true, false or an integer 0..5 (it can only lower the budget, never raise it)")
    if cfg.scratch in cfg.backup_files:
        bad("a backup file may not be the scratch folder")
    return cfg
