# 07 - Linting, stubs and "MicroPython IntelliSense" (complaint 2)

Scope: why Pylance/Pyright does not understand the user's custom MicroPython firmware libraries, how the
ecosystem (micropython-stubs, MicroPico, Pylance, Pyright, basedpyright, ty, ruff, mypy) solves or fails to solve
that, and a concrete design for the new extension, backed by prototypes that were actually run.

Date of research: 2026-10-12. Host: macOS 24.6 (darwin x64), Node 26.5, Python 3.15.0.
Old extension = `../mpy-workbench` (MPY Workbench 0.3.2, read-only reference).

Evidence tags used throughout:
- **[E]** executed and observed by me (command + output in section 11).
- **[R]** read in code/docs (source file:line or URL given).
- **[I]** inference; the text says how to confirm or refute it.

No serial port was opened. The only "board" I ran code on is a MicroPython **unix-port build that I compiled
from the current MicroPython master into the scratchpad** (a normal host process).

---------------------------------------------------------------------------------------------------------------

## 0. Executive summary

1. **The old extension has no IntelliSense support at all** [R/E]. Grepping `src/`, `scripts/`, `package.json`,
   `README.md`, `CHANGELOG.md` for `stubPath|typeshed|extraPaths|pylance|python.analysis|pyright|.pyi|stubs`
   returns nothing. It does not depend on `ms-python.python` (`package.json:11` `"extensionDependencies": []`),
   does not write `.vscode/settings.json`, does not ship stubs. So every MicroPython import (`machine`, `network`,
   `utime`...) *and* every custom module is "unresolved" unless the user set Pylance up by hand. Complaint 2 is
   therefore not a bug to fix; it is a missing feature, and it is **independent of the fix-vs-rewrite decision**
   (the same module would be added to either).

2. **Four different things get lumped together as "custom libraries"**, each with a different fix:
   | Kind | Where the truth lives | Fix | Prototype result |
   |---|---|---|---|
   | (a) plain `.py` files copied to the board `/lib` (what the old extension mirrors locally) | local `lib/` | put `lib` on `extraPaths` | [E] `import localutil` from `lib/` is **unresolved by default**, resolved with `extraPaths:["lib"]` |
   | (b) frozen Python modules (`manifest.py`: `freeze/package/module/require/include`) | real `.py` on the developer's disk | evaluate `manifest.py`, add the source roots to `extraPaths` | [E] 99/99 upstream manifests: static JS evaluator == real `manifestfile.py` (roots and module lists identical) |
   | (c) C user modules (`MP_REGISTER_MODULE`) | C source only; no Python source exists | generate `.pyi` from the C tables (+ optional `//|` / sidecar hand-written stubs) | [E] 98.7 % name recall vs runtime `dir()` on 25 real core modules; arity/types inferred; catches `set_speed("a")` |
   Plus (d) `.mpy`-only libraries (precompiled, no source) which can only be handled with hand-written or
   board-introspected stubs.

3. **Runtime introspection of the live board cannot recover signatures** [E]. I ran the real
   `micropython-stubber` `createstubs.py` (v1.29.0) against my fake firmware: every function, including pure-Python
   frozen ones, comes out as `def f(*args, **kwargs) -> Incomplete`. With those stubs pyright reports 0 errors
   and also **misses the real bug** that real source / C-scan stubs catch. Introspection is useful only for
   *inventory* (what modules/names exist), which is how it should be used (drift detection + fallback).

4. **Stock board stubs: bundle them, do not `pip install` them** [E/R]. `micropython-<port>[-<board>]-stubs` wheels
   are 130-155 KB each (MIT, PyPI), unpack to ~1.1 MB. A classroom lab network cannot be assumed to reach PyPI.
   Bundle the ESP32 family for the last ~6 MicroPython releases (~5-10 MB), pick by `sys.implementation` of the
   connected board.

5. **The way stubs are wired matters more than which stubs.** Experimentally [E] (pyright 1.1.414):
   - Pylance/pyright resolve **CPython typeshed stdlib stubs *before* `extraPaths` and before `site-packages`**
     for stdlib names. Installing the stub package into the `.venv` (zero config) or into `extraPaths` fixes
     `machine`/`network`/`neopixel` but **leaves `time.sleep_ms`, `time.ticks_ms`, `utime.sleep_us`,
     `os.ilistdir`, `sys.print_exception`, `asyncio.sleep_ms` flagged as errors**. That is the classic complaint and
     what a class of sophomores will hit in the first lab (`time.sleep_ms`).
   - Working wirings: `stubPath` (priority 1) with the stock stubs *flattened* + the MicroPython stdlib overrides,
     or `typeshedPath` pointed at the package. I recommend a managed `stubPath` directory
     (`.mpy-workbench/stubs/active`). Both gave identical results on a typical student script.
   - Host OS leaks into results: with `pythonPlatform: Windows` (pyright's default on a Windows host)
     `os.uname()` is flagged even with MicroPython's stdlib stubs. Pin `pythonPlatform: "Linux"` so macOS and
     Windows machines in the same class see identical diagnostics. This key exists only in
     `pyrightconfig.json`/`pyproject.toml`, **not** in any Pylance setting.

6. **Use `pyrightconfig.json` + `extends`, not `.vscode/settings.json`, as the primary mechanism** [E/R].
   Config file works for Pylance, Pyright, basedpyright and the CLI (basedpyright ignores `python.analysis.*`
   settings entirely), and it is the only place for `pythonPlatform`. When a config file exists, pyright-langserver
   ignores several `python.analysis.*` settings [E]. The design: a **generated, extension-owned**
   `.mpy-workbench/pyright.generated.json` (environment only: `pythonPlatform`, `stubPath`, `extraPaths`) and a
   **user-owned** `pyrightconfig.json` (`extends` + `typeCheckingMode` + rule severities) that is created once and
   never rewritten. Gotchas verified [E]: a child `extraPaths` *replaces* the base list; a child
   `typeCheckingMode` silently discards base rule overrides; a missing `extends` target degrades softly.

7. **The MicroPico extension (installed, 4.6.1) is the cautionary tale** [R]: global `~/.micropico-stubs`, symlinks
   (its changelog is full of "Pylance doesn't work after reopening", "failed on external drive", "Windows shell
   error"), `typeshedPaths` (only first entry honoured), and a settings writer that does
   `JSON.parse(settings.json) ?? {}` then `JSON.stringify` - which **wipes a settings.json that contains a single
   comment** (simulated [E]). Do not copy that mechanism; do copy the idea of per-board switchable stubs, the
   `reportMissingModuleSource: none` default, and bundling stubs in the VSIX.

Recommended design (section 9): `MPY Workbench: Set Up / Update MicroPython IntelliSense`, run automatically on
first workspace use (with consent), on board connect (board identity -> stock stub package), and on demand /
file-watch for firmware sources; all generated files live under `.mpy-workbench/`; the only root file is
`pyrightconfig.json`, created once; JSONC edits go through `jsonc-parser`; fallbacks for `pyproject.toml` and
VS Code forks.

---------------------------------------------------------------------------------------------------------------

## 1. What the old extension does (and does not do) about linting

All [R]; paths relative to `../mpy-workbench`.

- `package.json:11-12` `"extensionDependencies": []`, `"extensionPack": []` - no dependency on Python/Pylance.
- `package.json:24-26` activation `onLanguage:python` only (so it activates for any Python file, but contributes no
  language intelligence).
- `package.json:360...` configuration properties are only `mpyWorkbench.autoSyncOnSave` (361), `rootPath` (391),
  `pythonPath` (406) and a few more; nothing about stubs/analysis.
- `grep -rn -i "stubPath|typeshed|extraPaths|pylance|python.analysis|pyright|\.pyi|stubs|lint|intellisense"
  src scripts package.json README.md CHANGELOG.md` -> **no hits**. The only `.vscode` hits are ignore lists
  (`src/sync.ts:75`, `src/extension.ts:99`, `src/boardOperations.ts:65`, `src/localFilesView.ts:20`).
- `src/pythonInterpreter.ts:113-170` resolves a Python interpreter (Python extension API, then
  `python.defaultInterpreterPath`) for running `mpremote`. That interpreter is the natural place to run the
  Python-tier `manifest.py` evaluation (section 6.1).
- Local mirror semantics: the workspace root mirrors the board root (`mpyWorkbench.rootPath`, default `/`;
  `src/boardOperations.ts:119-125`, `src/esp32Fs.ts:122`). On an ESP32 `sys.path` is `['', '.frozen', '/lib']`
  (`mp_init()` seeds `''` and, when frozen modules exist, `.frozen`: `micropython/py/runtime.c:147-150`;
  `ports/esp32/main.c:144` appends `/lib`). Therefore:
  - the workspace root is automatically a pyright import root (good: `import helper` for `./helper.py` works),
  - **`<workspace>/lib` is not** [E: variant `M_lib`]: `import localutil` with the file in `lib/` gives
    `Import "localutil" could not be resolved` until `"extraPaths": ["lib"]` is added. If the user's "custom
    libraries" are the files they keep in `/lib` on the board, this is the whole of complaint 2.
- Sync ignore defaults (`src/sync.ts:73-84`: `.git/ .vscode/ node_modules/ dist/ out/ build/ __pycache__/ .DS_Store
  .mpy-workbench/`) do **not** include `pyrightconfig.json`, `typings/` or `.venv/`. Because the workspace root is
  the board root, a root-level `pyrightconfig.json` would be uploaded to the board unless the new extension adds it
  to the default ignore list (`src/extension.ts:90-150` writes the default `.mpyignore`; `.venv/` is there but
  `pyrightconfig.json` is not).

Root causes of complaint 2, ranked:
1. (high) No stubs/config exist: stock modules unresolved. Refute: open any workspace with the old extension and
   check Pylance output "Search paths" - it lists no MicroPython stub path. [R + E baseline variant A: 13 unresolved
   imports, 7 attribute errors for a 40-line script.]
2. (high if libs are in `/lib`) local `lib/` is not on the import path [E].
3. (medium) frozen/C-module libraries from a custom firmware build exist only as manifest entries / C source [R/E].
4. (medium, cosmetic but confusing) Pylance's default `typeCheckingMode` is `off` [R: Pylance `package.json`], which
   downgrades `reportMissingImports` to **warning** (yellow squiggle) [E variant A in "off"], so students see
   "linter does not recognise" yellow underlines everywhere and learn to ignore them.
5. (low) `.mpy` precompiled libs: no source, no stub.

I could not tell from the request which of (a)/(b)/(c)/(d) applies. See open questions.

---------------------------------------------------------------------------------------------------------------

## 2. The stub ecosystem (facts, with sources)

### 2.1 micropython-stubs (Jos Verlinde / josverl)
- Repo https://github.com/Josverl/micropython-stubs, docs https://micropython-stubs.readthedocs.io/ [R].
  The user's "MicroPython VS Code extension by Joshua Verlinde": I could not find such an extension; searches only
  find the stubs project (docs describe Pylance configuration, not an extension). Treat as a mis-remembered name
  (author is "Jos Verlinde"). `mpy-shed` is not a project I could find either; **`_mpy_shed` is a helper package
  shipped inside every stub package** [E: `esp32/_mpy_shed/` contains `_mp_available.pyi`, `_mpy_builtins.pyi`,
  `io_mp.pyi`, `IRQs.pyi`, `buffer_mp.pyi`, `blockdevice.pyi`, ...].
- PyPI naming [R https://micropython-stubs.readthedocs.io/en/main/packages.html]:
  `micropython-<port>-stubs` (generic board) and `micropython-<port>-<board>-stubs`, lower-case, e.g.
  `micropython-esp32-esp32_generic_s3-stubs`. Version = firmware version + `.postN` (`1.29.0.post1`).
- Versions [E: PyPI JSON API]: latest on 2026-10-12 is **1.29.0.post1** for esp32 / esp32_generic / s3 / c3 / s2 /
  rp2 / rpi_pico_w, and `micropython-stdlib-stubs 1.29.0.post2` (dependency `~=1.29.0`). `micropython-esp32-stubs`
  has 19 distinct MicroPython versions (1.17 ... 1.29); `micropython-esp32-esp32_generic-stubs` only from 1.21.
  Wheel size: 129-140 KB per board package, 154 KB stdlib stubs; all MIT (`METADATA: License-Expression: MIT`).
- Package layout [E: unpacked 1.29.0.post1 esp32]: flat `*.pyi` of the port at the root (`machine.pyi`, `network.pyi`,
  `time.pyi`, `utime.pyi`, `uasyncio.pyi`, `neopixel.pyi`, `esp32.pyi`, `umqtt/`, ...), `_mpy_shed/`, **`stdlib/`**
  (27 entries: MicroPython-modified typeshed subset: `builtins, typing, os, sys, json, asyncio, io, collections, array,
  struct, ssl, ...` + `VERSIONS`) and `stubs/` (`mypy-extensions`). 1.5 MB unpacked incl. dist-info, 129 files / 767 kB
  after my flattening.
- Which `stdlib/` entries actually carry MicroPython content [E: grep for `MicroPython|_mpy_shed|mp_available`]:
  `_asyncio, array, asyncio/*, builtins, collections, io, json, os, ssl, struct, sys`. (`re`, `typing`, `abc`, `enum`,
  `types` ... are plain typeshed copies - do not shadow them.)
- Official configuration advice [R https://micropython-stubs.readthedocs.io/en/main/22_vscode.html]:
  `python.languageServer: Pylance`, `typeCheckingMode: basic`, `diagnosticSeverityOverrides.reportMissingModuleSource: none`,
  `python.analysis.typeshedPaths: [".venv/Lib/site-packages"]` (or `["typings"]`), stubs installed with
  `pip install -U micropython-<port>-stubs --no-user --target ./typings`. The page also states "Pylance (and
  Pyright) do not by default allow you to override the stdlib stubs" - **confirmed experimentally** [E, variants
  C and F]. "Go to Definition" lands in a CPython file; use "Go to Type Definition" to see the stub.
- Quick-setup script advertised: `uv run https://raw.githubusercontent.com/Josverl/micropython-stubs/refs/heads/main/setup_micropython_stubs.py`
  (needs network + uv; not suitable for a locked-down lab).

### 2.2 micropython-stubber (the stub *generator*)
- PyPI `micropython-stubber` 1.29.0, `requires_python <4.0,>=3.10`, ~30 dependencies incl. `mpremote==1.29.0`,
  `mpflash==1.29.0`, `mypy`, `pyright`, `ruff`, `libcst`, `pygithub` [R: PyPI JSON]. Far too heavy to ship or to
  ask students to install; it is a tool for stub maintainers.
- On-device collector `src/stubber/board/createstubs.py` (1316 lines, 48 KB, v1.29.0) [E: cloned HEAD `56f5b5b`, ran it].
  Key facts:
  - **Module list is hard-coded** (`createstubs.py:1030` `stubber.modules = [...]`, ~130 names; comments at lines 145
    and 1026 "there is no option to discover modules from micropython"). Custom modules (`motorctl`, `robotics_lab`) are
    not stubbed unless added via `Stubber.add_modules()` (`createstubs.py:210`) [E: I had to set `s.modules = [...]`].
  - It must be invoked as a library with `no_auto_stubber.txt` present, otherwise importing it runs `main()`
    (`createstubs.py:1308-1309`).
  - It walks `dir()` and `inspect` where available. For functions it emits `def name(*args, **kwargs) -> Incomplete`.
    **Output for my fake firmware** [E]:
    ```
    def set_speed(*args, **kwargs) -> Incomplete: ...      # C module
    def drive(*args, **kwargs) -> Incomplete: ...           # frozen pure-Python module
    class Encoder():  PPR: Final[int] = 360;  def __init__(self, *argv, **kwargs) -> None: ...
    ```
    Constants and class membership are right; signatures are lost even for pure-Python frozen code (MicroPython
    standard builds have no `inspect.signature`).
  - Offline-usable: output is plain `.pyi` files (+ `modules.json` report). Needs a board (or unix build) and a way
    to copy files back (`mpremote cp`/`fs`). RAM-hungry on small boards (`createstubs_mem.py`, `_db.py` variants exist).
- Pyright check with stubber output for the custom modules [E variant J]: 0 diagnostics, i.e. **false sense of
  safety**: `motorctl.set_speed("a")` is not flagged.

### 2.3 MicroPico (paulober.pico-w-go 4.6.1, installed) - how it configures Pylance [R]
Files: `~/.vscode/extensions/paulober.pico-w-go-4.6.1-darwin-x64/` (`package.json`, `dist/extension.js` minified,
`mpy_stubs/`, `readme.md`, `changelog.md`).
- Bundles `mpy_stubs/` = `micropython_rp2_rpi_pico2_w_stubs-1.26.0.post1.dist-info` + `micropython_stdlib_stubs-1.26.0.post3`
  (i.e. the same wheels, unpacked: port `.pyi` at root + `stdlib/` + `stubs/` + `_mpy_shed/`). Pico-only by default;
  ESP32 via `micropico.extra.switchStubs`, which shells out to `pip install <pkg>==<ver> --target ~/.micropico-stubs/<pkg>==<ver>`
  (needs pip + network; `dist/extension.js` function `Qa`) and offers `micropython-esp32-stubs`,
  `micropython-esp32-esp32_generic_s3-stubs`, rp2 pico/pico_w.
- Copies bundled stubs to **`~/.micropico-stubs/included`** (global, shared by every project; literal `~` written
  into settings, which only Pylance's settings loader expands - pyrightconfig.json does not support `~`
  [R: pyright configuration.md "Paths with shell variables (including ~) are not supported"]).
- "Initialize project" writes `.vscode/settings.json` with `python.languageServer: Pylance`,
  `python.analysis.typeCheckingMode: basic`, `python.analysis.diagnosticSeverityOverrides.reportMissingModuleSource: none`,
  `python.terminal.activateEnvironment: false`, `python.analysis.typeshedPaths: [<stubs>]` **and**
  `python.analysis.extraPaths: [<stubs>]`, plus `.vscode/extensions.json` recommendations and a `.micropico` marker.
  Rationale of using both: `typeshedPaths` swaps stdlib (`stdlib/` subtree), `extraPaths` supplies the root-level port
  stubs - matching what I measured (variant D).
- Settings I/O (`dist/extension.js`, functions `En`/`Cn`): `JSON.parse(readFile)` in try/catch returning `undefined`
  on failure, then `defaults(...)`/`union(...)`, then `JSON.stringify(obj, null, 4)` written back. A settings.json
  with any `//` comment fails `JSON.parse` -> `{}` -> **the file is overwritten with only MicroPico's keys**. Simulated
  with the same algorithm on a commented file [E, section 11.10]: all user settings lost.
- Changelog evidence of the fragility of the global/symlink design (`changelog.md`): line 224 "#226 Pylance doesn't work
  after reopening", 225 "#227 Switch stubs error", 252 "#215 #209 Failed to switch stubs on Linux and macOS / use stubs on
  external drive", 259 "#202 Switch stubs Windows shell error", 621 "#23 Configure project does not link Stubs: directory
  link -> junction". `readme.md:26`: its virtual workspace for the Pico "does disable Pylance auto-completion".
- `package.json`: `extensionDependencies: ["ms-python.python"]`; recommends `ms-python.vscode-pylance`.

---------------------------------------------------------------------------------------------------------------

## 3. Pylance / Pyright mechanics that the design depends on

### 3.1 Import resolution order (docs) vs observed
Docs [R https://github.com/microsoft/pyright/blob/main/docs/import-resolution.md]:
1 `stubPath` (default `typings`), 2 workspace root then `extraPaths` (then `src` heuristic), 3 installed packages
(stub packages, inline stubs, py.typed, library code), 4 **stdlib typeshed**, 5 third-party typeshed, 6 same-dir fallback.
Observed with pyright 1.1.414 [E]:
- `stubPath`: shadows stdlib (`time.pyi` in `typings/` fixed `time.sleep_ms`).
- `extraPaths` containing `time.pyi` and `site-packages` containing `time.pyi`: **do not** shadow stdlib.
  `reveal_type(time.sleep)` after `import time` printed CPython's `(seconds: SupportsFloat | SupportsIndex, /) -> None`
  while `machine` (no typeshed stub) resolved from the same extra path. So the documented order only holds for
  non-stdlib names. Direct evidence is for `time` (variants C and F); the same mechanism is the only explanation I have
  for `utime` (its stub does `from time import *`, `utime.pyi:2`) and I generalise it [I] to the other stdlib names:
  *anything that has a stdlib typeshed stub (`time, os, sys, json, random, socket, struct, io, re,
  collections, asyncio, array, select, ssl, ...`) can only be overridden through `stubPath` or `typeshedPath`.*
  Refute by putting an `os.pyi` with a unique symbol in `extraPaths` and checking `reveal_type`.
- `typeshedPath` pointing at the stub package root replaces the **entire** bundled typeshed (27 stdlib entries instead of
  282); CPython-only modules that the board lacks (`string`, `datetime`, `dataclasses`) are *still not flagged* because
  pyright falls back to the interpreter's real stdlib source files [E: no diagnostic for `import string`/`datetime` in
  any variant]. There is no cheap way to warn "this module is not on the board" with pyright alone (idea in 9.9).
- Namespace packages split across several roots resolve [E]: `micropython-lib`'s `umqtt.simple` and `umqtt.robust`
  (two roots, no `__init__.py`) -> both imports resolve with both roots in `extraPaths`.
- `extraPaths` globs (`"drivers/*/*"`) work in pyright 1.1.414 [E] and were added to Pylance in 2026.3.100
  (pre-release; `changelog.md:111` of the installed 2026.4.1, "Globs in extra paths"). Do not rely on globs for
  compatibility with older Pylance; expand globs in the generator.
- Dot-directories are auto-excluded from analysis (`Auto-excluding **/.*` in verbose log), so `.mpy-workbench/stubs/**`
  is importable but never type-checked itself. (If stubs were put in a visible `typings/` the pyright CLI would report
  errors *inside the stub files*: ~22 spurious errors from `machine.pyi`, `network.pyi`, `_mpy_shed/...` appeared in variant B
  until I filtered to the project files. Pylance only reports open files by default, but `diagnosticMode: workspace` would show them.)

### 3.2 Settings vs config file precedence
Docs: "If a pyproject.toml (with a pyright section) or a pyrightconfig.json exists, any pyright settings in a VS Code
settings.json will be ignored" [R configuration.md "Overriding settings (in VS Code)"]; `pyrightconfig.json` beats
`pyproject.toml`. Pylance docs page does not say.
I drove **pyright-langserver 1.1.414 over LSP** with a scripted client (`workspace/configuration` replies carrying
`python.analysis.*`) [E, section 11.8]:

| Scenario | Result |
|---|---|
| S1 no config; settings `extraPaths:[lib_a,lib_b]` | both resolved |
| S1b no config; settings `stubPath` | honoured (stub-only warning proves it) |
| S5b no config; settings `diagnosticSeverityOverrides` | honoured |
| S2 config `extraPaths:[lib_a]` + settings `[lib_b]` | **lib_b unresolved** (config key replaces settings) |
| S3 config without `extraPaths` + settings `[lib_a,lib_b]` | both resolved (settings still apply for keys the config omits) |
| S4 config exists + settings `stubPath` | **settings stubPath ignored** |
| S5 config exists + settings `diagnosticSeverityOverrides` | **ignored** (config's own severities applied) |
| S6 `pyproject.toml [tool.pyright] extraPaths` + settings | same as S2 (pyproject acts as config) |
| S7 config `{}` + settings `typeshedPaths` | ignored |

Caveats: this is pyright-langserver, not Pylance. Pylance has its own layer (its changelog line 3607 historically
describes "defaults, then settings overrides, then pyrightconfig values"). **Not verified in Pylance 2026.4.1**
(license forbids running its bundle outside VS Code; I only read it). Verification step in the test plan: in VS Code
run "Python: Show Language Server Output" and compare the logged search paths with the expected list.

Other Pylance facts [R: installed `ms-python.vscode-pylance-2026.4.1`, `package.json`, `dist/server.bundle.js`, `changelog.md`]:
- `python.analysis.typeshedPaths` description is just "Paths to look for typeshed modules."; server code uses only
  `u[0]` (`typeshedPaths[0]` -> `typeshedPath`), consistent with pyright docs "honors only the first path".
- `python.analysis.stubPath` in settings.json is resolved relative to the **workspace folder**, not the settings file
  (description string; changelog line 97); in a config file it is relative to the config file.
- `pythonPlatform` is **not** a Pylance setting (`package.json` has none) - config file only.
- Pylance exposes `python.analysis.diagnosticsSource: "Pylance" | "Pylance + Pyright" | "Pylance + Pyrefly"`,
  `languageServerBackend: default|rust`, and Pyrefly notifications. Risk: if Pylance's diagnostics source moves to
  Pyrefly, `pyrightconfig.json` semantics may not carry over (open risk).
- `extends` is implemented in the Pylance bundle (`resolveExtends(configObj, configDirUri)` in `pyright.bundle.js`).
  An unknown key logs `Config contains unrecognized setting "<key>"` (so no `$comment` keys; use JSONC comments - pyright
  parses config as JSONC [E: generated file with `//` header header accepted by pyright and basedpyright]).

### 3.3 `extends` semantics (verified [E], pyright 1.1.414 and basedpyright 1.40.2)
- Relative paths inside the **base** file resolve relative to the *base file's* directory (generated paths therefore must be
  computed relative to `.mpy-workbench/`).
- Top-level keys in the child **replace** the base's (no merge): child `extraPaths:["course_lib"]` made all five custom
  modules and `lib` unresolved again.
- A child `typeCheckingMode` re-derives the rule set and **discards rule overrides in the base** (base
  `reportMissingModuleSource: none` + child `typeCheckingMode: basic` -> 12 warnings reappear). Consequence: severities
  live in the user-owned child only.
- Missing base file: pyright prints `Config file ".../pyright.generated.json" could not be read.` but still applies the
  child's own keys (soft failure) - so a repo that gitignores `.mpy-workbench/` degrades, it does not break.

### 3.4 Severity defaults that shape what students see
From pyright `configuration.md` rule table: `reportMissingImports` = warning in `off`, error in basic/standard/strict;
`reportMissingModuleSource` = warning in all modes; `reportAttributeAccessIssue` = none in off, error otherwise;
`reportCallIssue` error from basic. With the classroom config (`basic` + `reportMissingModuleSource:none`) I measured
exactly the two intended errors (section 11.7). `standard` produced identical output for the test files.

---------------------------------------------------------------------------------------------------------------

## 4. Experiment matrix (what actually happens) [E]

Test project: a 40-line `main.py` (stock modules `machine, network, neopixel, esp32, utime, uasyncio, micropython`;
MicroPython-only APIs `time.sleep_ms/ticks_ms`, `utime.sleep_us`; five custom modules from a fake firmware: C module
`motorctl`, frozen `robotics_lab`, frozen package `lab_helpers`, `labkit` (package), `imu_mpu6050` (module)), `probe.py`
(`os.ilistdir`, `sys.print_exception`, `asyncio.sleep_ms`, `time.sleep_ms`), `student.py` (typical student code),
one deliberately wrong call `motorctl.set_speed("a")` and one legacy kwarg `PWM(pin, freq=, duty=)`.
Counts are diagnostics in those three files (pyright 1.1.414, `typeCheckingMode: standard`, `reportMissingModuleSource: none`
unless noted):

| Variant | Wiring | Diags | Remaining problems |
|---|---|---|---|
| A baseline (what the old extension gives) | none | 20 | 13 unresolved imports (stock + custom), 7 attr errors |
| B stock stubs copied to `typings/` (root-level .pyi only) | stubPath default | 8 | custom 5; `os.ilistdir`, `sys.print_exception`, `asyncio.sleep_ms` (nested `stdlib/` not reachable) |
| C stock package root on `extraPaths` | extraPaths | 12 | custom 5; **`time.sleep_ms`, `ticks_ms`, `utime.sleep_us`, `os.ilistdir`, ... still flagged** |
| F `pip install micropython-esp32-stubs` into the `.venv` that holds `mpremote`, no config | site-packages | 12 | identical to C: stdlib-named modules not overridden |
| D `typeshedPath`=package root **and** `extraPaths`=package root (MicroPico/stubs-docs style) | typeshed | 6 | custom 5 + legacy `duty=` |
| H flattened stock stubs in `typings/` + custom roots + C-module stub | stubPath | 2 | intended arity bug caught + legacy `duty=` |
| K final generator output (managed `stubPath` + `extraPaths` via `extends`) | stubPath | 2 | same as H |
| J stubber-generated stubs for custom modules | stubPath | 0 | **misses** the real arity bug |
| E_gen_py / E_gen_static (earlier layout) | extends | 1 | arity bug caught |
| basedpyright 1.40.2 on K config | same file | identical | `$comment` key warned -> removed |
| ty 0.0.86 | `--extra-search-path` | 9 | custom resolved, stdlib-first behaviour same as pyright (`time.sleep_ms` flagged) |
| mypy 2.4.0 | `MYPYPATH` | 16 | custom resolved; **errors reported inside the stock stub files** (noisy) |
| ruff 0.17.0 | n/a | n/a | no import resolution at all; only F401/E style |

Interesting stub-quality datum: `PWM(Pin(5), freq=1000, duty=512)` is flagged ("No parameter named duty") by the
1.29 ESP32 stubs although old ESP32 firmware accepts `duty=`. Stubs generated from docs can false-positive on legacy-but-valid
code; the design needs an overlay mechanism (9.6) and a documented "friendly" preset (downgrade `reportCallIssue` to warning).

---------------------------------------------------------------------------------------------------------------

## 5. Alternatives to Pylance (d)

| Tool | Resolves custom `extraPaths`/stubs? | Reads `pyrightconfig.json`? | Fit |
|---|---|---|---|
| **Pylance** (`ms-python.vscode-pylance`) | yes | yes | Default in Microsoft VS Code. Licence: "only with Microsoft Visual Studio, VS Code, ..." [R: installed `LICENSE.txt` section 1(a)]; Cursor users report its environment checks refuse to start Pylance, and a May 2026 community article describes binary patches for Cursor/VSCodium/Antigravity (unverified, and patching likely violates licence section 2) [R: forum.cursor.com threads]. |
| **Pyright** (`ms-pyright.pyright`, MIT) | yes | yes | Listed on VS Marketplace and (per a README) Open VSX. Same core, no Pylance extras. |
| **basedpyright** (`detachhead.basedpyright`, Open VSX + Marketplace) | yes [E] | yes [E: identical output] | Best fork-friendly replacement. **Ignores `python.analysis.*`; uses `basedpyright.analysis.*`** (only `python.pythonPath`/`venvPath` read from `python.*`) [R docs.basedpyright.com language-server-settings]. Default `typeCheckingMode` is stricter (`recommended`) -> student noise unless the user-owned config sets `basic`. |
| **ty** (Astral, 0.0.86 on 2026-10-09, beta) | yes via `--extra-search-path` (CLI verified; config-file key names not checked) | no (`ty.toml`/`pyproject`) | pre-1.0, rule names differ, same stdlib-first behaviour [E]. Watch, do not ship. |
| **Ruff** 0.17 | n/a | n/a | linter/formatter only, never resolves imports, so it never complains about MicroPython modules; fine as an optional style layer, **cannot replace** the type checker. |
| **mypy** 2.4 | yes with `MYPYPATH` | no | analyses stub files strictly -> noise from the stock stubs [E]; not for students. |

Consequence: write `pyrightconfig.json` (works in four of the six), and if neither Pylance nor a pyright-based
extension is installed, show one actionable notification (offer `ms-python.vscode-pylance` in VS Code, `detachhead.basedpyright`
elsewhere). Do not mirror settings into `basedpyright.analysis.*` unless config-file mode is impossible.

---------------------------------------------------------------------------------------------------------------

## 6. Custom firmware modules: every case

### 6.1 Frozen Python modules - evaluate `manifest.py` (case 1)
Authoritative DSL implementation: `tools/manifestfile.py` of the firmware tree (I read the current master copy,
HEAD `424cb8d`; line numbers below are in that file). Docs: https://docs.micropython.org/en/latest/reference/manifest.html.

| DSL call | Semantics (what matters for source roots) | manifestfile.py |
|---|---|---|
| `metadata(description,version,license,author,...)` | no files; must be first call in `require()`d manifests | 334 |
| `include(path_or_list, **kw)` | executes another manifest relative to the current one; directory -> its `manifest.py`; kwargs become `options` | 348 |
| `require(name, version=None, pypi=None, library=None, **kw)` | finds `<lib>/**/<name>/manifest.py` in the registered libraries (default `$(MPY_LIB_DIR)/{micropython,python-stdlib,python-ecosys}`), `include`s it | 421, 414 |
| `add_library(name, path, prepend=False)` | registers an extra library root searched by `require` | 462 |
| `package(pkg, files=None, base_path=".", opt=None)` | all `.py` under `base_path/pkg` -> module name `pkg...`; **import root = `base_path`** | 477 |
| `module("m.py", base_path=".")` | single file; **import root = `base_path`** | 499 |
| `freeze(path, script=None, opt=None)` (+ `freeze_as_str/_as_mpy/_mpy`) | everything under `path` (or `script` subpath), module names start *after* `path`; **import root = `path`** | 581, 620-636 |
| `c_module(path)` | **new in 2026**: directory with `micropython.mk`/`.cmake`; recorded, no files | 522 |
| path variables | `$(MPY_DIR) $(MPY_LIB_DIR) $(PORT_DIR) $(BOARD_DIR)` substituted textually | 216 |
| `options` global | `IncludeOptions(**kwargs)`, `options.defaults(...)` | 177 |

Key observation: **source roots are computable**: root = (file path) minus (target path). That is what I use.

Two-tier evaluator (both prototyped and compared):

- **Tier 1 - run the firmware tree's own `manifestfile.py`** in the user's Python (the same interpreter used for mpremote),
  `python -I manifest_probe.py '<json>'` (full source in section 12.1). Wrapped leniently: every DSL call is caught, errors
  are collected and evaluation continues; an always-present `c_module` recorder handles older trees; `MODE_FREEZE` exists
  in all versions. 0.27 s wall (incl. Node start) for the stock ESP32 manifest [E]. Faithful by construction,
  and the DSL version always matches the firmware. **Executes arbitrary Python from the firmware tree**: only in trusted
  workspaces, `-I`, 20 s timeout, no network, never auto-run on an unopened repo.
- **Tier 2 - static JS evaluator, no code execution**: comment-stripping tokenizer, balanced-paren call finder, Python
  literal evaluator (strings, `None/True/False`, numbers, lists/tuples, `a + b`, `os.path.join(...)`), semantics table above,
  recursion for `include`/`require`, `$(VAR)` substitution, `if/else` blocks assumed taken (flagged), non-literal args skipped
  with a warning. 0.16 s [E]. Used when Python/`manifestfile.py` is unavailable, in untrusted workspaces, or as a cross-check.
- Do **not** use a bare regex over the file: `require()` recursion and `include("$(PORT_DIR)/...")` need real resolution.

Parity test [E] (`fuzz_manifests.mjs`, 99 `manifest.py` files in `ports/**` + `extmod/**` of current master, with
`PORT_DIR/BOARD_DIR/MPY_LIB_DIR` set): **root sets and module lists identical in 99/99**. The 6 manifests that still show
"differences" are those that reference the empty `arduino-lib` git submodule in my shallow clone; both tiers report the
same missing-library error (see Arduino boards) - i.e. the difference is only the error list, not the result. One genuine
divergence was found and fixed (`alif`: static evaluator added a root for a missing freeze directory).
Stock ESP32 manifest result: 17 roots, 22 modules (`asyncio`, `uasyncio`, `espnow`, `_boot`, `aioespnow`, `dht`, `ds18x20`,
`neopixel`, `onewire`, `umqtt.*`, `upysh`, `urequests`, `requests`, `ssl`, `mip`, `ntptime`, `webrepl`, ...).

Classification of roots: **upstream** (under `MPY_DIR`/`MPY_LIB_DIR`) vs **user** (everything else). Add user roots first; add
upstream roots last (after `stubPath`), because the stock stubs are better typed than upstream `.py` for the same names, and
because upstream `ports/esp32/modules/machine.py` is a shim (`from machine import *` with `sys.path` blanked, plus PCNT helper
classes) that would otherwise shadow the real `machine.pyi` with a self-importing `.py`.
Over-approximation to document: `module("x.py", base_path="src/drivers")` puts the *directory* on the path, so a sibling file that
is not frozen also resolves in the editor. Acceptable; an exact mode could generate a shadow dir of re-export stubs.

Where the manifest comes from (decision order): `mpyWorkbench.firmware.manifest` setting -> `manifest.py` in the workspace -> a
user-picked firmware folder (`FROZEN_MANIFEST` is passed on the make/cmake line, not stored in the tree, so it must be asked
once and remembered). Path variables: `MPY_DIR` from the setting or discovered by `py/mpconfig.h`; `PORT_DIR`/`BOARD_DIR` from
the board identity (`ports/<port>/boards/<_build>`) when available.

### 6.2 C user modules (case 2)
There is no Python source anywhere. MicroPython exposes only runtime objects (`<function>` with no signature [E], section 11.4).
Generation sources, best first:
1. **Hand-written `<module>.pyi` next to the C file** (copied verbatim; always wins).
2. **`//|` comment blocks in the C source** - the CircuitPython convention (`tools/extract_pyi.py`, e.g.
   `shared-bindings/digitalio/__init__.c` has `//| """Basic digital pin support`) [R: fetched from adafruit/circuitpython].
   Supported in the prototype: the block is emitted verbatim and suppresses auto-generation for names it defines. Works with
   `class Encoder:` bodies, docstrings, overloads.
3. **Auto-generation from the C tables** (prototype `scanCModule`, ~190 lines, regex over comment-stripped source):
   - modules: `MP_REGISTER_MODULE(MP_QSTR_x, obj)` -> `mp_obj_module_t obj = {.globals = &dict}` ->
     `MP_DEFINE_CONST_DICT(dict, table)` -> `mp_rom_map_elem_t table[] = { {MP_ROM_QSTR(MP_QSTR_n), value}, ... }`.
   - value kinds: `MP_ROM_PTR(&fun_obj)`, `&type_obj`, `MP_ROM_INT(n)` -> `int`, `MP_ROM_TRUE/FALSE`, `MP_ROM_NONE`,
     `MP_ROM_QSTR` -> `str`, static/class method wrappers.
   - functions: `MP_DEFINE_CONST_FUN_OBJ_0/1/2/3(obj, cfunc)` -> parameter **names recovered from the C function's parameter list**
     (`channel_obj` -> `channel`), types guessed from `mp_obj_get_int/float/str/is_true(param)`, return type from the
     `return` expressions (`mp_const_none` -> `None`, `mp_obj_new_float` -> `float`, ...). `_VAR`, `_VAR_BETWEEN` ->
     `*args`; `_KW` -> keyword names/types parsed from `static const mp_arg_t allowed_args[]` (`MP_ARG_KW_ONLY|MP_ARG_INT`).
   - classes: `MP_DEFINE_CONST_OBJ_TYPE(obj, MP_QSTR_Name, flags, make_new, fn, locals_dict, &d, ...)` (and the pre-1.19
     `const mp_obj_type_t` struct style); methods from the locals table (first parameter becomes `self`), `__init__` arity from
     `mp_arg_check_num(n_args,n_kw,min,max,false)`.
   Generated output for my fixture [E]:
   ```python
   def set_speed(channel: int, speed: float) -> None: ...
   def get_speed(channel: int) -> float: ...
   def version() -> str: ...
   def calibrate(*args: Any) -> bool: ...
   def configure(*, kp: Any = ..., ki: int = ...) -> None: ...
   MAX_CHANNELS: int
   DEBUG: bool
   ```
   and pyright then reports `Argument missing for parameter "speed"` for `motorctl.set_speed("a")` (also under `basic`).
   Accuracy on real code [E, `accuracy.mjs`]: scanned 25 core MicroPython C modules (`framebuf, heapq, hashlib, json, re, binascii,
   random, time, deflate, machine, platform, select, math, cmath, gc, struct, collections, array, io, sys, micropython, _thread,
   builtins, os, websocket`) and compared with `dir(module)` of my unix build: **299/303 runtime names found (98.7 %)**; the 4 misses are
   names assigned dynamically at startup (`sys.path/ps1/ps2`, `time.clock`); 43 extra names are `#if`-guarded entries absent from
   that build (the right behaviour for a stub that must serve builds with different features).
   Limits (be honest in UI): regex, not a C parser; macro-generated tables, `MP_REGISTER_EXTENSIBLE_MODULE` delegation, C++, and
   attribute handlers (`attr`) are not understood; unresolved entries are emitted as `name: Any  # unresolved: ...`. A tree-sitter-c
   upgrade is possible but adds WASM weight; the `//|` and sidecar paths are the escape hatch.
4. Board introspection (6.3) for inventory/validation only.

### 6.3 Runtime introspection via mpremote (case 3)
- `help('modules')` [E on unix build]: prints all builtin + frozen module names in columns; frozen packages appear as
  `labkit/__init__`, `labkit/pid`, `asyncio/core`; ends with "Plus any modules on the filesystem". Parseable by whitespace split;
  gives *board inventory* to compare with local roots/stubs ("board has `motorctl`, no stub or source found").
- `dir()` / `__dict__` walk: names + kinds, constants' values; no signatures [E].
- My tiny collector (`device_introspect.py`, 54 lines, section 12.2): imports a given list of modules, walks `dir()` to depth 2,
  prints one JSON line `@@MPYINTRO@@{...}` of 786 bytes for the fixture, 7 ms on the host build. Intended to be run through the same
  serialised `mpremote exec` queue as everything else (never concurrently with REPL/run).
- Versus `createstubs.py`: 1316 lines (50 KB), hard-coded module list, writes files on the board's flash, needs a copy-back step,
  heavy on small RAM; but gives full `.pyi` for *stock* modules (that is how the stock stub packages are produced). For custom
  modules it adds nothing over the tiny collector (both lose signatures).
- Probe for board identity (also tiny; all fields exist on MicroPython, use `getattr` for older ones):
  `sys.implementation` -> `name`, `version` tuple, `_machine`, `_mpy`, `_build` (= `MICROPY_BOARD_BUILD_NAME`, i.e. the board name,
  `ESP32_GENERIC` or `ESP32_GENERIC-SPIRAM` with variant; `py/modsys.c:104`, `py/mkrules.cmake:28-30`), `os.uname()` (`sysname` = port,
  `release`, `version`, `machine` = "<board name> with <MCU>"). `_build` is absent on old firmware (then match `machine`
  or fall back to the generic port package). I could not run this against the ESP32 (no serial access allowed); format verified on the
  unix build: `(name='micropython', version=(1, 30, 0, 'preview'), _machine=..., _mpy=2822, _build='standard', _thread='unsafe')`.

### 6.4 Board-specific built-ins and choosing the stub package (case 4)
Mapping implemented and unit-tested [E, `test_pick.mjs`, real PyPI release lists]: `sysname` -> port (`pyboard` -> `stm32`),
`_build` (before `-`) lower-cased -> board, candidate packages
`micropython-<port>-<board>-stubs` -> (`micropython-<port>-stubs`), then version choice = exact `M.m.p` if published, else the
nearest **older** published release (stubs that are newer describe APIs the board lacks -> missed errors are safer than false errors),
highest `.postN`; if a board package starts after the firmware (e.g. `esp32_generic` starts at 1.21) fall through to the generic port
package. Results:

| Board report | Chosen |
|---|---|
| esp32, ESP32_GENERIC, 1.26.0 | micropython-esp32-esp32_generic-stubs 1.26.0.post1 (exact) |
| esp32, ESP32_GENERIC-SPIRAM, 1.27.0 | esp32_generic 1.27.0.post1 |
| esp32, ESP32_GENERIC_S3, 1.28.0 | esp32_generic_s3 1.28.0.post4 |
| esp32, no `_build`, 1.19.1 | micropython-esp32-stubs 1.19.1.post15 |
| esp32, 1.30.0 preview | esp32_generic 1.29.0.post1 (nearest older) |
| esp32, custom board `MYLAB_ESP32` | micropython-esp32-stubs (generic port package) |
| pyboard/PYBV11 1.25.0 | micropython-stm32-stubs 1.25.0.post3 |

### 6.5 CPython and MicroPython coexistence (case 5)
Problems and the fix for each (all [E] unless noted):
- Stock modules unresolved -> stubs (managed `stubPath`).
- `time/os/sys/json/asyncio/io/collections/struct/array/ssl` MicroPython-only API flagged -> these **must** come via `stubPath`/`typeshedPath`
  (extraPaths/site-packages cannot override stdlib). The allow-list for flattening is `os sys json asyncio io collections array struct ssl _asyncio`;
  never flatten `builtins/typing/types/abc/enum/_typeshed` (they are in the package's `stdlib/` but are not MicroPython API).
- `utime`, `uasyncio`, `ujson`... exist as separate stubs in the package root (some re-export `from time import *` and therefore
  inherit the stdlib resolution problem unless `time.pyi` is itself overridden - it is, via `stubPath`).
- Host OS leakage: stubs copy typeshed's `sys.platform` conditionals; `pythonPlatform: Windows` (default on a Windows host) hides `os.uname`
  [E with stock stubs *and* with MicroPython's `stdlib/os`]; `Linux`, `Darwin`, `All` do not. Pin `Linux`.
- `from micropython import const`, `@micropython.native`, `machine.Pin` etc. resolve through the port stubs [E].
- Unavailable CPython modules (`string`, `datetime`, `dataclasses`, `typing` extras) are **silently accepted** (resolved from the interpreter's
  stdlib) [E]. Mitigation (optional feature 9.9): an import-availability diagnostic fed by the board inventory.
- Accidental CPython execution ("Run Python File" in the Python extension) is outside this analysis (see run-file analyses).

### 6.6 Local mirror of the board filesystem (case 6)
The workspace root is an implicit import root; `lib/` is not (section 1). Always add `lib` (and the configured `rootPath`-relative
equivalent) first in `extraPaths` when it exists. On ESP32 search order is `''`, frozen, `/lib`, so a local `lib/foo.py` shadows a frozen `foo`;
that matches order `workspace root > lib > user frozen roots > upstream`.
Special case (d): `*.mpy` in `/lib` or `freeze_mpy`: no source -> need `.pyi` (hand-written, `course-stubs/`, or introspection fallback).

---------------------------------------------------------------------------------------------------------------

## 7. Strategy comparison (i)-(iv)

| | (i) only write settings | (ii) bundle stubs | (iii) download on demand | (iv) generate from firmware/board |
|---|---|---|---|---|
| Size | 0 | wheels 130-155 KB; ESP32 family x last 6 releases ~5-10 MB in VSIX | same as installed (~1.1 MB/workspace) | KBs |
| Offline in a locked lab | works only if stubs already there | **works** | **fails** (PyPI/GitHub blocked, proxies, TLS inspection) | works if firmware tree present locally |
| Maintenance | none, but nothing works | re-bundle per MicroPython release via a build script (`pip download` of pinned wheels, run in CI); stub packages post-release often | none in-repo, but breakage = support load | generator code must track the MicroPython macros / manifest DSL |
| Failure modes | missing files, wrong paths | stale vs newest firmware (mitigate: "nearest older" + optional online refresh) | pip missing, no admin, wrong Python, proxy, Windows PowerShell quoting (MicroPico #202) | regex limits (6.2), manifest needs Python, firmware tree not on student machines |
| Covers custom modules | no | no | no | **yes** |
Recommendation: (ii) + (iv), (i) only as the *thin writer* that wires them in; (iii) as an explicit, optional "Refresh stubs from PyPI" command when
the network allows.

---------------------------------------------------------------------------------------------------------------

## 8. Why not the simplest options

- "pip install stubs into the .venv (next to mpremote)": zero-config *for port modules*, but leaves `time.sleep_ms` etc. broken (variant F), depends
  on the right interpreter being selected, needs the network, and mixes lab tooling with student env. Not enough.
- "global stub directory + `~` in settings" (MicroPico): per-user state shared by all projects, symlink/junction issues on Windows, fails on external drives
  and on roaming profiles; breaks `pyrightconfig.json` (no `~`).
- "`typeshedPaths` only": works in Pylance when no config file exists (first entry only), but replaces the whole bundled typeshed, fights with any
  config file, and is not honoured by basedpyright (`basedpyright.analysis.typeshedPaths` is a different key).
- Editing `python.analysis.*` in `.vscode/settings.json` as the main path: ignored when a config file exists (S4, S5), invisible to basedpyright,
  cannot express `pythonPlatform`, and JSONC editing is risky.

---------------------------------------------------------------------------------------------------------------

## 9. Recommended design: "MicroPython IntelliSense" in the new extension

### 9.1 Principles
1. One authoritative, **environment-only** generated file; strictness lives in a user-owned file that is created once.
2. No symlinks, no global state, no network at runtime, forward-slash relative paths, per-workspace copy of stubs (~1.1 MB).
3. Never write to a file we do not own without a diff + consent; all edits idempotent (second run = zero diff).
4. Everything is explainable: a report file and an output channel say which paths were chosen and why.

### 9.2 Files
Managed (extension may overwrite freely), all under `.mpy-workbench/` (already ignored by sync and hidden from the tree: `src/sync.ts:83`, `src/localFilesView.ts:17`):
- `.mpy-workbench/pyright.generated.json` - JSONC with a header comment; keys only `pythonPlatform: "Linux"`, `stubPath`, `extraPaths`.
- `.mpy-workbench/stubs/active/` - unpacked bundled stock stubs for the selected board/version, flattened (port root + allow-listed stdlib overrides), then overlaid with `course-stubs`/overlay files.
- `.mpy-workbench/stubs/custom/*.pyi` - generated C-module stubs (and copies of hand-written ones).
- `.mpy-workbench/intellisense.json` - profile (board id, version, chosen package, firmware paths, input hashes) for staleness checks.
- `.mpy-workbench/intellisense-report.json` - what was found/skipped/failed (feeds a "Show IntelliSense report" webview and a Problems entry).
User-owned, created once with consent:
- `pyrightconfig.json` at the workspace root:
  ```jsonc
  {
    // Created by MPY Workbench. Yours to edit; it is never rewritten.
    "extends": ".mpy-workbench/pyright.generated.json",
    "typeCheckingMode": "basic",
    "reportMissingModuleSource": "none"
    // Do NOT add "extraPaths" here - it would replace the generated list.
    // Use the setting mpyWorkbench.intellisense.extraPaths instead.
  }
  ```
Optional, additive only: `.vscode/extensions.json` recommendations (`ms-python.vscode-pylance` / `detachhead.basedpyright`), `.gitignore` lines for
`.mpy-workbench/stubs/`, and **default sync-ignore additions**: `pyrightconfig.json`, `typings/`, `.venv/`, `course-stubs/` (the workspace root is the board root).
Not written by default: `.vscode/settings.json` (only in the fallback modes below).

### 9.3 Commands (`MPY Workbench: ...`)
- `Set Up MicroPython IntelliSense` (wizard: language server check, board/profile, firmware tree (optional), preview of files, write).
- `Update MicroPython IntelliSense` (non-interactive regeneration; also what watchers and "board connected" call).
- `Select Stubs for Board...` (QuickPick: auto-detected, bundled list, "from firmware", "off").
- `Detect Board and Match Stubs` (runs the identity probe via the serialised mpremote queue; read-only).
- `Generate Stubs from Firmware Source...` (pick firmware folder -> evaluate manifest -> scan C modules -> report).
- `Generate Stub from Board (introspect)...` (fallback for `.mpy`/unknown modules; signatures are `*args`).
- `Export Course Stubs...` (instructor: copies user frozen sources and generated stubs to `course-stubs/` so students do not need the firmware tree).
- `Show IntelliSense Report` / `Check IntelliSense Health` (config precedence conflicts, missing language server, stale stubs).

### 9.4 Settings (all `mpyWorkbench.*`, machine-overridable where noted)
`intellisense.autoConfigure: "prompt" | "always" | "never"` (default prompt; instructors set `always` in the template workspace settings),
`intellisense.stubs: "auto" | "<package>@<version>" | "off"`, `intellisense.extraPaths: string[]` (merged into the generated list),
`intellisense.customStubDirs: string[]` (hand-written overlay, e.g. `course-stubs`), `intellisense.pythonPlatform` (default `Linux`),
`intellisense.evaluateManifest: "auto" | "python" | "static"`, `firmware.path`, `firmware.manifest`, `firmware.mpyDir`, `firmware.mpyLibDir`,
`firmware.portDir`, `firmware.boardDir`. (Settings stay in VS Code settings; they are inputs, not pyright config.)

### 9.5 Generation algorithm (all prototyped, section 11/12)
1. Resolve profile: setting override > connected-board probe (cached per port+serial id) > workspace marker > default (ESP32 latest).
2. Unpack the bundled wheel(s) -> `stubs/active` (copy port root + stdlib allow-list). Skip if input hash unchanged.
3. If a firmware tree is configured: evaluate manifest (tier by setting/trust), classify roots, scan C modules, write `stubs/custom`.
4. Local roots: `lib` (if present), user frozen roots, `stubs/custom`, upstream roots; apply `mpyWorkbench.intellisense.extraPaths`; expand any globs.
5. Write `pyright.generated.json` atomically (temp file + rename) only if content changed (avoid language-server restarts).
6. Ensure `pyrightconfig.json` is present and extends it (see merge policy). Then prompt to reload/restart language server only if it did not pick the change up (pyright watches config files).

### 9.6 Avoiding clobbering user configuration (merge policy)
- Detect first: `pyrightconfig.json` present? `pyproject.toml` with `[tool.pyright]` (Pylance itself uses `/^[ \t]*\[tool\.pyright\]/m`)? settings with `python.analysis.*`?
- **No config at all** -> create the user-owned template (after consent).
- **Existing `pyrightconfig.json`** -> parse as JSONC; if it already `extends` something else, do not touch (report); if it defines `extraPaths`, `stubPath` or
  `typeshedPath` (these would shadow or replace ours) -> show a conflict panel with three choices: (1) move those entries to `mpyWorkbench.intellisense.extraPaths`/`customStubDirs`
  and add `extends` (JSONC `modify` edit, comments preserved), (2) keep as is and only show the report, (3) cancel.
- **`[tool.pyright]` in `pyproject.toml`** -> do not create `pyrightconfig.json` (it would silently take precedence per pyright docs); explain and offer to add
  `extends = ".mpy-workbench/pyright.generated.json"` by a minimal TOML line edit (or show the snippet).
- **Settings-only fallback** (user refuses a root file, or a language server that only reads settings): write namespaced keys with `jsonc-parser`
  (`modify` with `isArrayInsertion`), never rewrite whole arrays, only set keys that are absent, tag with a trailing `// mpy-workbench` comment, mirror to `basedpyright.analysis.*` when that extension is installed.
- JSONC handling [E demo]: `jsonc-parser@3.3.1` `modify/applyEdits` preserves comments, trailing commas, unrelated keys; the whole-array replace **drops comments inside the array**; array insertion keeps comments but a trailing
  comment may visually attach to the neighbouring new element (cosmetic). Hence the design avoids editing user arrays at all. Preserve BOM and CRLF; use `FormattingOptions.eol`.
- Never delete user files; "Remove IntelliSense" deletes only `.mpy-workbench/stubs/**` and the generated file and offers to remove the `extends` line.

### 9.7 When it runs
- First activation in a workspace that looks like a board project (has `boot.py`/`main.py`, `.mpy-workbench/`, or `pyrightconfig.json` with our `extends`): prompt once (`autoConfigure: prompt`).
- Activation: if our `extends` target is missing/stale (fresh clone with `.mpy-workbench/` ignored) -> silent regeneration (~300 ms).
- Board connect: probe identity once per connection; if the profile differs from stored -> toast with "Switch stubs from 1.29 to 1.26.0 (ESP32_GENERIC)?" (auto when `stubs: auto` and `autoConfigure: always`).
- File watchers (debounced, 1 s): `manifest.py`, `lib/` structure, C module sources, `course-stubs/`.
- Never block activation; everything async with progress in the status bar item and an output channel `MPY IntelliSense`.

### 9.8 Classroom workflows
- **Instructor** (has firmware repo): run Generate Stubs from Firmware Source, then `Export Course Stubs` (frozen sources and generated `.pyi` into `course-stubs/`), commit `pyrightconfig.json` + `course-stubs/` + workspace settings (`autoConfigure: always`).
  Students need no firmware tree, no Python beyond mpremote, no network.
- **Student**: open folder, connect board; the extension picks the bundled stub version from `sys.implementation`; zero prompts when the instructor's template says `always`.
- **Windows/macOS parity**: `pythonPlatform: Linux`, forward slashes, no symlinks, no PowerShell calls, no `~`, copies not links, path normalisation tests on both.

### 9.9 Optional later features (ranked)
1. Import-availability diagnostic: warn on `import datetime`/`string`... not provided by stubs, local roots or board inventory (needs a `DiagnosticCollection`; board inventory from `help('modules')` cached).
2. "Friendly" preset: downgrade `reportCallIssue`/`reportArgumentType` to warnings, and a "Mute this stub complaint" quick fix that appends to the overlay.
3. Inlay: show `Go to Type Definition` hint on first hover into a CPython file.
4. Online "Refresh stubs" when a newer post-release exists.

---------------------------------------------------------------------------------------------------------------

## 10. Test plan

Automated (CI on `windows-latest`, `macos-latest`, `ubuntu-latest`, pinned `pyright`/`basedpyright` as devDependencies):
1. **Manifest parity**: run tier 1 vs tier 2 on all manifests of a pinned MicroPython tag (+ micropython-lib) - roots and module lists equal (script `fuzz_manifests.mjs`; baseline 99/99 on master).
2. **C scanner golden tests**: fixtures for each macro kind; accuracy job comparing against `dir()` of a freshly built unix port (nightly; baseline 98.7 %); `//|` and sidecar precedence; unresolved entries.
3. **Picker table tests** for `pickStubPackage` with a vendored copy of the PyPI release index (offline); property: result is never newer than the board unless nothing older exists.
4. **Generator end-to-end**: fixture projects (frozen + C + lib + local mirror) -> run pyright CLI -> assert exact diagnostic set (the 2 intended errors). Run on all three OSes to catch `pythonPlatform` leakage (`os.uname` on Windows) and path-separator bugs.
5. **JSONC merge**: round-trip tests - comments, trailing commas, BOM, CRLF, tabs, empty file, `{}` , invalid JSON (must refuse, not overwrite), read-only file, second run no diff.
6. **Conflict cases**: existing `pyrightconfig.json` with own `extraPaths`/`extends`/`stubPath`; `[tool.pyright]` pyproject; multi-root workspace; workspace root != board root (`rootPath`); spaces/non-ASCII/UNC/OneDrive paths; firmware tree on a missing network drive.
7. **Safety**: manifest with an infinite loop / `os.system` / syntax error: timeout, `-I`, not run in untrusted workspace, static fallback result still produced; manifest referencing missing submodule: partial result + error list.
8. **Stub health**: unit check that every `.pyi` in `stubs/active` parses (pyright `--outputjson` on the directory, expect only warnings), and that `STDLIB_OVERRIDES` still exist in a newly bundled wheel (fail the bundle script if the package layout changes).
Manual in VS Code (Pylance 2026.4.x and basedpyright):
9. Output -> "Python Language Server": effective search paths equal `stubPath` + `extraPaths` list; hover on `machine.Pin` shows MicroPython docs; `time.sleep_ms` has no squiggle; `import motorctl` resolves; wrong arity flagged; verify settings-vs-config precedence on real Pylance (the one thing I could not execute).
10. Fresh clone with `.mpy-workbench/` ignored: soft failure then auto-regeneration.
11. Mac + Windows lab machine without internet: connect board, stubs selected from bundle, no network calls (use a firewall rule or offline VM).
12. Switch board/version: stubs swap, no restart needed (pyright reloads on config/stub change).

---------------------------------------------------------------------------------------------------------------

## 11. What I ran and observed (reproducible record)

Scratchpad root: `<scratchpad>` (**session-temporary; copy
the files you want from there**). Abbreviated `$SP`.

11.1 Tooling installed (scratchpad only): `npm i pyright` -> 1.1.414 (`$SP/pyright-env`), `npm i basedpyright` -> 1.40.2 (`$SP/basedpyright-env`, separate dir because its `bin` clobbers `pyright`),
`pip install --target` of `ty 0.0.86`, `ruff 0.17.0`, `mypy 2.4.0` (`$SP/ty-env/pkgs`), `micropython-esp32-stubs 1.29.0.post1 + micropython-stdlib-stubs 1.29.0.post2` (`$SP/stubs-dl/esp32`),
a venv with `mpremote 1.29.0` + the stubs (`$SP/venv-proj`), `jsonc-parser 3.3.1` (`$SP/jsonc-demo`). Shallow clones: `micropython` HEAD `424cb8d` (`$SP/src-mp/mp`), `micropython-lib` (`$SP/src-mp/mplib`),
`micropython-stubber` HEAD `56f5b5b` (`$SP/src-stubber/ms`). No global installs, nothing written into `mpy-workbench`.

11.2 Fake firmware tree `$SP/proto/fakefw`: `manifest.py` (`include("$(MPY_DIR)/extmod/asyncio")`, `freeze("modules")`, `package("labkit", base_path="src")`, `module("imu_mpu6050.py", base_path="src/drivers")`,
`c_module("cmods/motorctl")`), frozen modules, and a C user module `motorctl` (`FUN_OBJ_0/1/2/VAR_BETWEEN/KW`, a class with `locals_dict`, int/bool constants, `//|` block for `Encoder`).

11.3 Built `mpy-cross` and the **unix port with that firmware**: `make -C ports/unix MICROPY_PY_BTREE=0 MICROPY_PY_FFI=0 MICROPY_PY_SSL=0 MICROPY_SSL_MBEDTLS=0 FROZEN_MANIFEST=$SP/proto/fakefw/manifest.py USER_C_MODULES=$SP/proto/fakefw/cmods BUILD=build-fakefw`
(first attempt failed on `-Wdouble-promotion`, fixed fixture, rebuilt OK, 451 KB binary).

11.4 Runtime facts from that binary: `help('modules')` lists `labkit/__init__ labkit/pid lab_helpers/__init__ robotics_lab imu_mpu6050 motorctl asyncio/...`;
`dir(motorctl)` = names only; `motorctl.set_speed` prints as `<function>`. `sys.implementation` = `(name='micropython', version=(1, 30, 0, 'preview'), _machine=..., _mpy=2822, _build='standard', _thread='unsafe')`.

11.5 `createstubs.py` (stubber 1.29.0) run through `micropython run_stub.py` with `no_auto_stubber.txt`: output files `motorctl.pyi`, `robotics_lab.pyi`, `labkit/pid.pyi`, ... all with `*args, **kwargs -> Incomplete` (quoted in 2.2).

11.6 Manifest evaluators: real `manifestfile.py` on the stock ESP32 manifest listed 28 files (17 roots, 22 top-level modules); `node tool/fuzz_manifests.mjs` -> `manifests=99 identical-roots-and-modules=99` (6 flagged only for the empty `arduino-lib` submodule / missing freeze dir).

11.7 Pyright matrix (section 4) via `$SP/proto/run.sh variants/<name>`; final classroom config run: user file `{extends, typeCheckingMode: basic|standard, reportMissingModuleSource: none}` -> exactly 2 errors:
`main.py:29 reportCallIssue Argument missing for parameter "speed"` and `student.py:28 reportCallIssue No parameter named "duty"`.

11.8 LSP precedence harness `$SP/proto/tool/lsp_precedence.mjs` (spawns `pyright-langserver --stdio`, answers `workspace/configuration`), scenarios S1-S7 (table in 3.2).

11.9 `pythonPlatform` experiment: `os.uname()` with MicroPython `stdlib/os` stubs: error only for `--pythonplatform Windows`; none for `All`, `Linux`, `Darwin`.

11.10 MicroPico-style settings rewrite simulated with Node on a commented `settings.json`: output contained only `python.analysis.extraPaths` (everything else lost). `jsonc-parser` edit kept every comment and key; array insertion kept inner comments.

11.11 Timing: tier 1 0.27 s, tier 2 0.16 s per run (Node start included) for the ESP32 manifest.

11.12 Not done (and why): no serial port or real board access (rule); did not execute Pylance itself (license; read its bundle/package.json/changelog instead); did not test on Windows; did not verify the Pylance `extends`
behaviour beyond reading `resolveExtends` in `pyright.bundle.js`; stubs for third-party C modules like `ulab`/`lvgl` not evaluated.

---------------------------------------------------------------------------------------------------------------

## 12. Prototype sources (copy from scratchpad; key pieces inlined)

Full prototypes: `$SP/proto/tool/mpy_intellisense.mjs` (533 lines: static manifest evaluator, python tier driver, C scanner, stock-stub installer, picker, config writer),
`manifest_probe.py`, `device_introspect.py`, `fuzz_manifests.mjs`, `accuracy.mjs`, `test_pick.mjs`, `lsp_precedence.mjs`, `compare.mjs`; fixture `$SP/proto/fakefw`; test projects `$SP/proto/variants/*`.

### 12.1 `manifest_probe.py` (tier 1 driver; run with `python -I`)
```python
import importlib.util, json, os, sys
def main():
    cfg = json.loads(sys.argv[1])
    spec = importlib.util.spec_from_file_location("manifestfile", cfg["manifestfile"])
    mf = importlib.util.module_from_spec(spec); spec.loader.exec_module(mf)
    errors, c_modules = [], []
    def lenient(name):
        def wrapper(self, *a, **k):
            try: return getattr(mf.ManifestFile, name)(self, *a, **k)
            except Exception as e: errors.append({"call": name, "args": [repr(x) for x in a][:3], "error": str(e)})
        return wrapper
    class Lenient(mf.ManifestFile):
        require = lenient("require"); include = lenient("include"); package = lenient("package")
        module = lenient("module"); freeze = lenient("freeze"); freeze_as_str = lenient("freeze_as_str")
        freeze_as_mpy = lenient("freeze_as_mpy"); freeze_mpy = lenient("freeze_mpy")
        def _manifest_globals(self, kwargs):
            g = super()._manifest_globals(kwargs)
            g["c_module"] = lambda p: c_modules.append(self._resolve_path(p))   # tolerate old trees too
            return g
    m = Lenient(mf.MODE_FREEZE, {k: v for k, v in cfg["path_vars"].items() if v})
    try: m.execute(cfg["manifest"])
    except Exception as e: errors.append({"call": "execute", "args": [cfg["manifest"]], "error": str(e)})
    files = []
    for f in m.files():
        full, target = os.path.normpath(f.full_path), os.path.normpath(f.target_path)
        root = full[: len(full) - len(target)].rstrip("\\/") if full.endswith(target) else os.path.dirname(full)
        files.append({"full_path": full, "target_path": target.replace("\\", "/"), "root": root})
    print(json.dumps({"files": files, "c_modules": c_modules, "errors": errors}))
main()
```

### 12.2 `device_introspect.py` (runs on the board through `mpremote exec`; module list injected by the extension)
```python
import sys
try: import json
except ImportError: import ujson as json
MODULES = ("motorctl", "robotics_lab")
def kind(o):
    t = type(o).__name__
    if t in ("function", "closure", "bound_method", "builtin_function_or_method"): return "func"
    if t == "type": return "class"
    if t == "module": return "module"
    return t if t in ("int", "float", "str", "bool", "bytes", "NoneType", "tuple", "list", "dict") else "obj"
def walk(o, depth):
    out = {}
    for n in dir(o):
        if n.startswith("__") and n.endswith("__"): continue
        try: v = getattr(o, n)
        except Exception: out[n] = {"k": "unreadable"}; continue
        k = kind(v); e = {"k": k}
        if k in ("int", "float", "str", "bool"): e["v"] = v
        if k == "class" and depth < 2: e["members"] = walk(v, depth + 1)
        out[n] = e
    return out
res = {"impl": {"name": sys.implementation.name, "version": list(sys.implementation.version[:3]),
                "build": getattr(sys.implementation, "_build", ""), "platform": sys.platform}, "mods": {}}
for m in MODULES:
    try: res["mods"][m] = walk(__import__(m), 0)
    except Exception as e: res["mods"][m] = {"error": repr(e)}
print("@@MPYINTRO@@" + json.dumps(res))
```

### 12.3 Generated `.mpy-workbench/pyright.generated.json` (from the fixture)
```jsonc
// GENERATED by MPY Workbench ("Update MicroPython IntelliSense"). Do not edit: it is rewritten on every update.
// Put your own overrides in ../pyrightconfig.json -- that file "extends" this one and is never touched.
{
  "pythonPlatform": "Linux",
  "stubPath": "stubs/active",
  "extraPaths": ["../lib", "../../../fakefw/modules", "../../../fakefw/src", "../../../fakefw/src/drivers", "stubs/custom",
                 "../../../../src-mp/mp/extmod", "../../../../src-mp/mp/extmod/asyncio"]
}
```
(paths relative to `.mpy-workbench/`; on Windows with a different drive the generator must emit absolute `C:/...` paths and mark the file machine-specific.)

### 12.4 Stock-stub installer rules
Copy every top-level entry of the unpacked wheel except `stdlib/`, `stubs/`, `README.md`, `LICENSE.md`, `pyproject.toml`, `*.dist-info`; then copy only `os sys json asyncio io collections array struct ssl _asyncio`
from its `stdlib/` (file or directory). Result for esp32 1.29.0.post1: 129 files, 767 kB content, 1.1 MB on disk. Ship `LICENSE.md` of the stubs (MIT) in the VSIX.

---------------------------------------------------------------------------------------------------------------

## 13. Open questions / unverified

1. Which kind of "custom library" does the user have: files in `/lib` (fixed by `lib` on the path), frozen modules from a firmware build (do they have the firmware repo on their machine; will students?), C user modules, or precompiled `.mpy`? The design covers all, but the default UX and the "Export Course Stubs" priority depend on it.
2. Exact MicroPython version/board of the class firmware (custom build -> `_build` name may match no stub package; generic port package is the fallback).
3. Pylance 2026.4.1 behaviour for settings-vs-config precedence and `extends` was not executed (read only); confirm with the language server output log.
4. Whether Pylance's `Pyrefly` diagnostics source will become default in the lifetime of this extension and whether it honours `stubPath`/`extraPaths`.
5. Whether to keep supporting VS Code forks (basedpyright) as first-class; only config-file mode is verified for it.
6. Stub quality issues (legacy `duty=` kwarg) - no data on how often students hit them; consider shipping a small course overlay.
7. Third-party C modules the class might use (`ulab`, `lvgl`, display drivers): no bundled stubs evaluated.
8. Windows-specific behaviour (absolute paths across drives, long paths, antivirus latency on the 129-file unpack, OneDrive) is untested.

---------------------------------------------------------------------------------------------------------------

## 12b. Full prototype sources (so nothing depends on the scratchpad surviving)

Run example: `node mpy_intellisense.mjs --fw <firmware dir> --out <project dir> --mpy-dir <micropython checkout> --mpy-lib <micropython-lib> --stubs <unpacked stub wheel dir> --mode python|static --python python3`.
Port to TypeScript inside the extension; keep the file layout of the outputs (section 9.2). `manifest_probe.py` (12.1) must sit next to it.

### 12.5 `mpy_intellisense.mjs` - complete prototype (manifest evaluators, C scanner, stub installer, picker, config writer)

````js
#!/usr/bin/env node
// Prototype: "MicroPython IntelliSense" generator for the mpy-upgrade extension.
//
//   node mpy_intellisense.mjs --fw <firmware dir> --out <project dir>
//        [--manifest <path>] [--mpy-dir <micropython checkout>] [--mpy-lib <micropython-lib>]
//        [--port-dir <dir>] [--board-dir <dir>] [--python <python exe>] [--mode python|static|both]
//        [--stubs <dir with stock micropython-<port>-stubs contents>]
//
// What it does (all offline):
//   1. Evaluate the firmware manifest.py  -> source roots of frozen modules   (tier 1: real
//      manifestfile.py via python; tier 2: pure-JS static emulation, no code execution)
//   2. Scan C user modules (MP_REGISTER_MODULE / MP_ROM_QSTR tables)         -> generated .pyi
//   3. Emit .mpy-workbench/pyright.generated.json (+ report) with extraPaths/stubPath/etc.
//
// This is a PROTOTYPE meant to be ported to TypeScript inside the extension.  It is
// deliberately dependency-free so the algorithms are easy to lift.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------------------- args
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return a;
}
const posix = (p) => p.split(path.sep).join('/');

// ----------------------------------------------------------------------------- tier 1: python
export function evalManifestWithPython({ python, manifestfile, manifest, pathVars }) {
  const cfg = JSON.stringify({ manifestfile, manifest, path_vars: pathVars });
  const r = spawnSync(python, ['-I', path.join(HERE, 'manifest_probe.py'), cfg], { encoding: 'utf8', timeout: 20000 });
  if (r.error || r.status !== 0) return { ok: false, error: r.error?.message || r.stderr };
  const j = JSON.parse(r.stdout);
  const roots = [];
  for (const f of j.files) if (!roots.includes(f.root)) roots.push(f.root);
  const modules = [...new Set(j.files.map((f) => f.target_path.split('/')[0].replace(/\.(py|mpy)$/, '')))];
  return { ok: true, tier: 'python', roots, modules, cModules: j.c_modules, errors: j.errors, files: j.files.length };
}

// ----------------------------------------------------------------------------- tier 2: static
// A tiny Python-literal tokenizer/evaluator.  It never executes anything.
function stripComments(src) {
  // remove # comments that are outside of string literals
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i];
    if (q) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === q) q = null;
    } else if (c === '"' || c === "'") { q = c; out += c; }
    else if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    else out += c;
    i++;
  }
  return out;
}
function splitTopLevel(s) {
  const parts = []; let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') cur += s[++i]; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
const UNKNOWN = Symbol('unknown');
function evalLiteral(expr) {
  expr = expr.trim();
  let m;
  if ((m = /^(['"])((?:\\.|(?!\1).)*)\1$/s.exec(expr))) return m[2];
  if (expr === 'None') return null;
  if (expr === 'True') return true;
  if (expr === 'False') return false;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  if ((m = /^[\[(](.*)[\])]$/s.exec(expr))) return splitTopLevel(m[1]).map(evalLiteral);
  // "a" + "b" and os.path.join("a", "b")  (the only non-literal forms seen in upstream manifests)
  if (expr.includes('+') && !/[(\[]/.test(expr)) {
    const parts = expr.split('+').map(evalLiteral);
    if (parts.every((p) => typeof p === 'string')) return parts.join('');
  }
  if ((m = /^os\.path\.join\((.*)\)$/s.exec(expr))) {
    const parts = splitTopLevel(m[1]).map(evalLiteral);
    if (parts.every((p) => typeof p === 'string')) return parts.join('/');
  }
  return UNKNOWN;
}
function parseCall(argText) {
  const pos = [], kw = {};
  for (const part of splitTopLevel(argText)) {
    const m = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.*)$/s.exec(part);
    if (m) kw[m[1]] = evalLiteral(m[2]); else pos.push(evalLiteral(part));
  }
  return { pos, kw };
}
function findCalls(src) {
  const names = 'metadata|include|require|add_library|package|module|c_module|freeze_as_str|freeze_as_mpy|freeze_mpy|freeze';
  const re = new RegExp(`^([ \\t]*)(${names})\\s*\\(`, 'gm');
  const calls = []; let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 1, q = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c; else if (c === '(') depth++; else if (c === ')') depth--;
    }
    calls.push({ name: m[2], conditional: m[1].length > 0, args: parseCall(src.slice(re.lastIndex, i - 1)) });
    re.lastIndex = i;
  }
  return calls;
}

function listPy(dir) {
  const out = [];
  const walk = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (/\.(py|mpy)$/i.test(e.name)) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

export function evalManifestStatic({ manifest, pathVars }) {
  const roots = []; const modules = new Set(); const cModules = []; const warnings = [];
  const libs = []; const visited = new Set();
  if (pathVars.MPY_LIB_DIR) for (const l of ['micropython', 'python-stdlib', 'python-ecosys']) libs.push(path.join(pathVars.MPY_LIB_DIR, l));
  const addRoot = (r) => { r = path.normalize(r); if (!roots.includes(r)) roots.push(r); };

  const run = (file) => {
    file = path.resolve(file);
    if (visited.has(file)) return;
    visited.add(file);
    let src;
    try { src = stripComments(fs.readFileSync(file, 'utf8')); } catch (e) { warnings.push(`cannot read ${file}`); return; }
    const dir = path.dirname(file);
    const sub = (p) => {
      for (const [k, v] of Object.entries(pathVars)) if (v) p = p.split(`$(${k})`).join(v);
      return path.resolve(dir, p);
    };
    for (const c of findCalls(src)) {
      const { pos, kw } = c.args;
      const bad = (...vals) => vals.some((v) => v === UNKNOWN);
      if (bad(...pos, ...Object.values(kw))) { warnings.push(`${path.basename(file)}: ${c.name}(...) has non-literal arguments, skipped`); continue; }
      if (c.conditional) warnings.push(`${path.basename(file)}: ${c.name}(${JSON.stringify(pos[0])}) is inside a block; assumed taken`);
      switch (c.name) {
        case 'freeze': case 'freeze_as_str': case 'freeze_as_mpy': case 'freeze_mpy': {
          const base = sub(pos[0]); const script = pos[1] ?? kw.script ?? null;
          if (fs.existsSync(base)) addRoot(base); else { warnings.push(`freeze base missing: ${base}`); break; }
          const scripts = script === null ? [null] : Array.isArray(script) ? script : [script];
          for (const s of scripts) {
            const target = s ? path.join(base, s) : base;
            let rel = [];
            try { rel = fs.statSync(target).isDirectory() ? listPy(target).map((f) => (s ? `${s}/${f}` : f)) : [s]; } catch { warnings.push(`freeze target missing: ${target}`); }
            for (const f of rel) modules.add(f.split('/')[0].replace(/\.(py|mpy)$/i, ''));
          }
          break;
        }
        case 'package': addRoot(sub(kw.base_path ?? pos[2] ?? '.')); modules.add(pos[0].split('/')[0]); break;
        case 'module': addRoot(sub(kw.base_path ?? pos[1] ?? '.')); modules.add(pos[0].split('/')[0].replace(/\.py$/i, '')); break;
        case 'c_module': cModules.push(sub(pos[0])); break;
        case 'add_library': libs.splice(kw.prepend ? 0 : libs.length, 0, sub(pos[1])); break;
        case 'include': {
          for (const p of Array.isArray(pos[0]) ? pos[0] : [pos[0]]) {
            let t = sub(p);
            try { if (fs.statSync(t).isDirectory()) t = path.join(t, 'manifest.py'); } catch { /* fallthrough */ }
            run(t);
          }
          break;
        }
        case 'require': {
          let found = false;
          for (const lib of libs) {
            const hit = findManifestFor(lib, pos[0]);
            if (hit) { run(hit); found = true; break; }
          }
          if (!found) warnings.push(`require("${pos[0]}"): not found in known libraries`);
          break;
        }
        default: break;
      }
    }
  };
  run(manifest);
  return { ok: true, tier: 'static', roots, modules: [...modules], cModules, errors: warnings.map((w) => ({ error: w })) };
}
function findManifestFor(libDir, name) {
  let ents;
  try { ents = fs.readdirSync(libDir, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const d = path.join(libDir, e.name);
    if (e.name === name && fs.existsSync(path.join(d, 'manifest.py'))) return path.join(d, 'manifest.py');
    const deeper = findManifestFor(d, name);
    if (deeper) return deeper;
  }
  return null;
}

// ----------------------------------------------------------------------------- C user modules
function stripCComments(src) {
  // keep //| lines (hand-written stub blocks); drop other comments but preserve newlines
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/(?!\|)[^\n]*/g, '');
}
function cArgs(s) { return splitTopLevel(s); }
const stripObj = (n) => n.replace(/^(?:mp_obj_t|mp_int_t|const\s+mp_obj_t\s*\*?)\s*/, '').replace(/_(obj|in|o|arg)$/, '').replace(/^\*+/, '');

function findFunctionDef(src, cname) {
  const re = new RegExp(`(?:static\\s+)?(?:mp_obj_t|void)\\s+${cname}\\s*\\(([^)]*)\\)\\s*\\{`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  // grab body by brace matching
  const start = m.index + m[0].length;
  let i = start, depth = 1;
  for (; i < src.length && depth > 0; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; }
  return { params: m[1].trim(), body: src.slice(start, i - 1) };
}
function inferReturn(body) {
  const rets = [...body.matchAll(/return\s+([^;]+);/g)].map((m) => m[1]);
  const kinds = new Set(rets.map((r) => {
    if (/mp_const_none/.test(r)) return 'None';
    if (/mp_obj_new_(small_)?int|mp_obj_new_int_from/.test(r)) return 'int';
    if (/mp_obj_new_float/.test(r)) return 'float';
    if (/mp_obj_new_str|mp_obj_new_qstr/.test(r)) return 'str';
    if (/mp_obj_new_bool|mp_const_true|mp_const_false/.test(r)) return 'bool';
    if (/mp_obj_new_bytes|mp_obj_new_bytearray/.test(r)) return 'bytes';
    if (/mp_obj_new_list/.test(r)) return 'list[Any]';
    if (/mp_obj_new_tuple/.test(r)) return 'tuple[Any, ...]';
    return 'Any';
  }));
  if (kinds.size === 0) return 'None';
  if (kinds.has('Any')) return 'Any';
  return [...kinds].join(' | ');
}
function inferParamType(body, cname) {
  const t = (fn, type) => new RegExp(`${fn}\\s*\\(\\s*${cname}\\b`).test(body) && type;
  return t('mp_obj_get_int(?:_truncated)?', 'int') || t('mp_obj_get_float(?:_to_f)?|mp_obj_get_float_to_d', 'float')
    || t('mp_obj_str_get_str|mp_obj_str_get_qstr', 'str') || t('mp_obj_is_true', 'bool') || 'Any';
}

function parseCSignature(src, cname, arity, kind) {
  const def = findFunctionDef(src, cname);
  const pyName = (n) => (/^[A-Za-z_]\w*$/.test(n) ? n : 'arg');
  if (kind === 'fixed' && def) {
    const params = def.params === 'void' || def.params === '' ? [] : cArgs(def.params).map((p) => p.split(/[\s*]+/).pop());
    return {
      params: params.map((p) => ({ name: pyName(stripObj(p)), type: inferParamType(def.body, p) })),
      ret: inferReturn(def.body),
    };
  }
  if (kind === 'fixed') return { params: Array.from({ length: arity }, (_, i) => ({ name: `arg${i + 1}`, type: 'Any' })), ret: 'Any' };
  // var / var_between / kw: try mp_arg_t allowed_args[] for names
  const ret = def ? inferReturn(def.body) : 'Any';
  const allowed = def && /allowed_args\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(def.body);
  if (allowed) {
    const items = [...allowed[1].matchAll(/\{\s*MP_QSTR_(\w+)\s*,\s*([^,}]+)/g)];
    const params = items.map((m) => ({
      name: m[1],
      type: /MP_ARG_INT/.test(m[2]) ? 'int' : /MP_ARG_BOOL/.test(m[2]) ? 'bool' : 'Any',
      kwOnly: /KW_ONLY/.test(m[2]),
      required: /REQUIRED/.test(m[2]),
    }));
    return { params, ret, fromAllowedArgs: true };
  }
  return { params: [], ret, varargs: true };
}

function renderParams(sig, { self = false, optionalFrom = Infinity } = {}) {
  const out = self ? ['self'] : [];
  if (sig.varargs) { out.push('*args: Any'); return out.join(', '); }
  let seenKwOnly = false;
  sig.params.forEach((p, i) => {
    if (p.kwOnly && !seenKwOnly) { out.push('*'); seenKwOnly = true; }
    const opt = !p.required && (p.kwOnly || i >= optionalFrom);
    out.push(`${p.name}: ${p.type}${opt ? ' = ...' : ''}`);
  });
  return out.join(', ');
}

export function scanCModule(dir) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(c|cc|cpp|h|hpp)$/i.test(e.name)) files.push(p);
  } };
  walk(dir);
  const raw = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const src = stripCComments(raw);

  // hand-written //| blocks (CircuitPython convention).  Names defined there win over generated ones.
  const handLines = raw.split('\n').filter((l) => /^\s*\/\/\|/.test(l)).map((l) => l.replace(/^\s*\/\/\| ?/, ''));
  const handNames = new Set(handLines.map((l) => /^(?:class|def)\s+(\w+)/.exec(l)?.[1]).filter(Boolean));

  // defines
  const funObjs = new Map(); // obj -> {arity|kind, cfunc}
  for (const m of src.matchAll(/MP_DEFINE_CONST_FUN_OBJ_(0|1|2|3|VAR_BETWEEN|VAR|KW)\s*\(\s*(\w+)\s*,([^;]*)\)\s*;/g)) {
    const a = cArgs(m[3]);
    const [kind, arity] = ({ 0: ['fixed', 0], 1: ['fixed', 1], 2: ['fixed', 2], 3: ['fixed', 3] })[m[1]] ?? [m[1].toLowerCase(), 0];
    funObjs.set(m[2], { kind, arity, cfunc: a[a.length - 1].trim(), nmin: kind === 'fixed' ? arity : Number(a[0]) });
  }
  const wrappers = new Map(); // static/class method wrappers
  for (const m of src.matchAll(/MP_DEFINE_CONST_(STATICMETHOD|CLASSMETHOD)_OBJ\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g)) wrappers.set(m[2], { kind: m[1].toLowerCase(), inner: m[3] });
  const dicts = new Map();
  for (const m of src.matchAll(/MP_DEFINE_CONST_DICT\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g)) dicts.set(m[1], m[2]);
  const tables = new Map();
  for (const m of src.matchAll(/mp_rom_map_elem_t\s+(\w+)\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/g)) {
    const ents = [...m[2].matchAll(/\{\s*MP_ROM_QSTR\(\s*MP_QSTR_(\w+)\s*\)\s*,\s*((?:[^{}]|\([^)]*\))+?)\s*\}/g)].map((e) => ({ name: e[1], value: e[2].trim() }));
    tables.set(m[1], ents);
  }
  const types = new Map(); // obj -> {name, make_new, locals}
  for (const m of src.matchAll(/MP_DEFINE_CONST_OBJ_TYPE\s*\(([\s\S]*?)\)\s*;/g)) {
    const a = cArgs(m[1]);
    const t = { obj: a[0].trim(), name: /MP_QSTR_(\w+)/.exec(a[1])?.[1] };
    for (let i = 3; i + 1 < a.length; i += 2) t[a[i].trim()] = a[i + 1].trim().replace(/^&/, '');
    types.set(t.obj, t);
  }
  for (const m of src.matchAll(/const\s+mp_obj_type_t\s+(\w+)\s*=\s*\{([\s\S]*?)\n\};/g)) { // pre-1.19 style
    const name = /\.name\s*=\s*MP_QSTR_(\w+)/.exec(m[2])?.[1];
    if (!name || types.has(m[1])) continue;
    types.set(m[1], { obj: m[1], name, make_new: /\.make_new\s*=\s*(\w+)/.exec(m[2])?.[1], locals_dict: /\.locals_dict\s*=\s*\(mp_obj_dict_t\s*\*\)\s*&(\w+)/.exec(m[2])?.[1] });
  }

  // modules
  const modules = [];
  for (const m of src.matchAll(/MP_REGISTER_(?:EXTENSIBLE_)?MODULE\s*\(\s*MP_QSTR_(\w+)\s*,\s*(\w+)\s*\)/g)) {
    const modObj = m[2];
    const mm = new RegExp(`mp_obj_module_t\\s+${modObj}\\s*=\\s*\\{[\\s\\S]*?\\.globals\\s*=\\s*\\(mp_obj_dict_t\\s*\\*\\)\\s*&(\\w+)`).exec(src);
    const table = mm && tables.get(dicts.get(mm[1]));
    modules.push({ name: m[1], entries: table ?? [] });
  }

  const renderFun = (entryName, objName, { self = false } = {}) => {
    const f = funObjs.get(objName);
    if (!f) return null;
    const sig = parseCSignature(src, f.cfunc, f.arity, f.kind);
    if (f.kind === 'fixed') {
      if (self) sig.params = sig.params.slice(1);
      return `def ${entryName}(${renderParams(sig, { self })}) -> ${sig.ret}: ...`;
    }
    const opt = f.kind === 'var_between' ? 0 : f.nmin;
    return `def ${entryName}(${renderParams(sig, { self, optionalFrom: opt })}) -> ${sig.ret}: ...`;
  };

  const renderClass = (name, t) => {
    const lines = [`class ${name}:`];
    const ents = tables.get(dicts.get(t.locals_dict)) ?? [];
    const mk = t.make_new && findFunctionDef(src, t.make_new);
    let init = '*args: Any, **kwargs: Any';
    if (mk) {
      const chk = /mp_arg_check_num\s*\(\s*n_args\s*,\s*n_kw\s*,\s*(\d+)\s*,\s*(\d+)/.exec(mk.body);
      if (chk) { const lo = Number(chk[1]), hi = Number(chk[2]); init = Array.from({ length: hi }, (_, i) => `arg${i + 1}: Any${i >= lo ? ' = ...' : ''}`).join(', '); }
    }
    lines.push(`    def __init__(self${init ? ', ' + init : ''}) -> None: ...`);
    for (const e of ents) {
      const wrapped = wrappers.get(e.value.replace(/^MP_ROM_PTR\(&(\w+)\)$/, '$1'));
      const objName = /^MP_ROM_PTR\(&(\w+)\)$/.exec(e.value)?.[1];
      if (/^MP_ROM_INT\(/.test(e.value)) lines.push(`    ${e.name}: int`);
      else if (objName && funObjs.has(objName)) lines.push('    ' + renderFun(e.name, objName, { self: true }));
      else if (wrapped) lines.push(`    # ${wrapped.kind} ${e.name}: signature not generated`, `    def ${e.name}(*args: Any) -> Any: ...`);
      else lines.push(`    ${e.name}: Any`);
    }
    return lines.join('\n');
  };

  const out = [];
  for (const mod of modules) {
    const L = ['# Generated by mpy-workbench from C source (MP_REGISTER_MODULE). Do not edit; add a hand-written',
      '# <module>.pyi next to the C file or //| lines in the C source to override.', 'from typing import Any', ''];
    if (handLines.length) { L.push('# --- hand-written //| blocks ---', ...handLines, ''); }
    for (const e of mod.entries) {
      if (e.name === '__name__' || handNames.has(e.name)) continue;
      const objName = /^MP_ROM_PTR\(&(\w+)\)$/.exec(e.value)?.[1];
      if (/^MP_ROM_INT\(/.test(e.value)) L.push(`${e.name}: int`);
      else if (/^MP_ROM_(TRUE|FALSE)$/.test(e.value)) L.push(`${e.name}: bool`);
      else if (e.value === 'MP_ROM_NONE') L.push(`${e.name}: None`);
      else if (/^MP_ROM_QSTR\(/.test(e.value)) L.push(`${e.name}: str`);
      else if (objName && funObjs.has(objName)) L.push(renderFun(e.name, objName));
      else if (objName && types.has(objName)) L.push('', renderClass(e.name, types.get(objName)), '');
      else L.push(`${e.name}: Any  # unresolved: ${e.value}`);
    }
    out.push({ module: mod.name, pyi: L.join('\n') + '\n', names: mod.entries.map((e) => e.name).filter((n) => n !== '__name__') });
  }
  return out;
}

// ----------------------------------------------------------------------------- assemble
function main() {
  const a = parseArgs(process.argv);
  const fw = path.resolve(a.fw);
  const out = path.resolve(a.out);
  const manifest = path.resolve(a.manifest ?? path.join(fw, 'manifest.py'));
  const pathVars = {
    MPY_DIR: a['mpy-dir'] && path.resolve(a['mpy-dir']),
    MPY_LIB_DIR: a['mpy-lib'] && path.resolve(a['mpy-lib']),
    PORT_DIR: a['port-dir'] && path.resolve(a['port-dir']),
    BOARD_DIR: a['board-dir'] && path.resolve(a['board-dir']),
  };
  const mode = a.mode ?? 'python';
  const python = a.python ?? 'python3';
  const manifestfile = pathVars.MPY_DIR && path.join(pathVars.MPY_DIR, 'tools', 'manifestfile.py');

  let res;
  if (mode !== 'static' && manifestfile && fs.existsSync(manifestfile)) res = evalManifestWithPython({ python, manifestfile, manifest, pathVars });
  if (!res?.ok) res = evalManifestStatic({ manifest, pathVars });

  // classify roots: upstream (inside MPY_DIR / MPY_LIB_DIR) vs user (everything else)
  const isUpstream = (r) => [pathVars.MPY_DIR, pathVars.MPY_LIB_DIR].filter(Boolean).some((u) => r === u || r.startsWith(u + path.sep));
  const userRoots = res.roots.filter((r) => !isUpstream(r));
  const upstreamRoots = res.roots.filter(isUpstream);

  // C modules -> generated stubs
  const stubRoot = path.join(out, '.mpy-workbench', 'stubs');
  const genDir = path.join(stubRoot, 'custom');
  fs.rmSync(genDir, { recursive: true, force: true });
  fs.mkdirSync(genDir, { recursive: true });
  const generated = [];
  for (const cdir of res.cModules) {
    for (const g of scanCModule(cdir)) {
      const handFile = fs.existsSync(path.join(cdir, `${g.module}.pyi`)) ? path.join(cdir, `${g.module}.pyi`) : null;
      fs.writeFileSync(path.join(genDir, `${g.module}.pyi`), handFile ? fs.readFileSync(handFile) : g.pyi);
      generated.push({ module: g.module, from: posix(path.relative(out, cdir)), handWritten: !!handFile, names: g.names });
    }
  }

  // Stock stubs (unpacked micropython-<port>[-<board>]-stubs wheel) -> flattened, managed stubPath dir
  let activeDir = null; let stockInfo = null;
  if (a.stubs) {
    activeDir = path.join(stubRoot, 'active');
    stockInfo = installStockStubs(path.resolve(a.stubs), activeDir);
  }

  // Paths in the generated file are relative to the generated file's own directory (pyright resolves them there).
  const cfgDir = path.join(out, '.mpy-workbench');
  const rel = (p) => posix(path.relative(cfgDir, p) || '.');
  const localLib = fs.existsSync(path.join(out, 'lib')) ? [rel(path.join(out, 'lib'))] : []; // mirror of the board's /lib (on sys.path)
  const extraPaths = [
    ...localLib,
    ...userRoots.map(rel),
    ...(generated.length ? [rel(genDir)] : []),
    ...upstreamRoots.map(rel), // after stubPath, so stock stubs still win for same-named modules
  ];
  const header = [
    '// GENERATED by MPY Workbench ("Update MicroPython IntelliSense"). Do not edit: it is rewritten on every update.',
    '// Put your own overrides in ../pyrightconfig.json -- that file "extends" this one and is never touched.',
  ].join('\n');
  // ENVIRONMENT ONLY.  Rule severities/typeCheckingMode deliberately live in the user-owned pyrightconfig.json:
  // pyright re-derives the whole rule set when a child config sets typeCheckingMode, silently discarding rule overrides
  // inherited from an `extends` base (observed with pyright 1.1.414).
  const config = {
    pythonPlatform: 'Linux', // same answers on macOS and Windows hosts (pyright evaluates sys.platform checks in stubs)
    ...(activeDir ? { stubPath: rel(activeDir) } : {}),
    extraPaths,
  };
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'pyright.generated.json'), header + '\n' + JSON.stringify(config, null, 2) + '\n');
  const report = { tier: res.tier, frozenModules: res.modules, userRoots: userRoots.map(rel), upstreamRoots: upstreamRoots.map(rel), cModules: generated, stockStubs: stockInfo, evalErrors: res.errors, extraPaths };
  fs.writeFileSync(path.join(cfgDir, 'intellisense-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

// ----------------------------------------------------------------------------- stock stubs
// Stdlib packages that micropython-stdlib-stubs re-defines with MicroPython-only API (os.ilistdir, sys.print_exception,
// asyncio.sleep_ms, io/struct/array/json/collections/ssl differences).  Verified by grepping the 1.29 package for
// MicroPython markers.  Everything else (typing, builtins, abc, enum, types, ...) is left to pyright's bundled typeshed.
export const STDLIB_OVERRIDES = ['os', 'sys', 'json', 'asyncio', 'io', 'collections', 'array', 'struct', 'ssl', '_asyncio'];
export function installStockStubs(pkgDir, activeDir) {
  fs.rmSync(activeDir, { recursive: true, force: true });
  fs.mkdirSync(activeDir, { recursive: true });
  const skip = new Set(['stdlib', 'stubs', 'README.md', 'LICENSE.md', 'pyproject.toml']);
  let files = 0, bytes = 0;
  const copy = (src, dst) => {
    const st = fs.statSync(src);
    if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src)) copy(path.join(src, e), path.join(dst, e)); }
    else { fs.copyFileSync(src, dst); files++; bytes += st.size; }
  };
  for (const e of fs.readdirSync(pkgDir)) if (!skip.has(e) && !e.endsWith('.dist-info')) copy(path.join(pkgDir, e), path.join(activeDir, e));
  const stdlib = path.join(pkgDir, 'stdlib');
  const applied = [];
  for (const m of STDLIB_OVERRIDES) {
    for (const cand of [m, `${m}.pyi`]) if (fs.existsSync(path.join(stdlib, cand))) { copy(path.join(stdlib, cand), path.join(activeDir, cand)); applied.push(cand); }
  }
  return { files, kB: Math.round(bytes / 1024), stdlibOverrides: applied };
}

// ----------------------------------------------------------------------------- choose the stub package for a board
// probe = what `mpremote exec` reports (sys.implementation / os.uname()).  available = { pkgName: [version strings] }.
const PORT_FROM_SYSNAME = { pyboard: 'stm32', 'esp32': 'esp32', rp2: 'rp2', esp8266: 'esp8266', mimxrt: 'mimxrt', samd: 'samd', nrf52: 'nrf', renesas: 'renesas-ra' };
const verKey = (v) => v.split('.').slice(0, 3).map((x) => parseInt(x, 10) || 0);
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
export function pickStubPackage(probe, available) {
  const port = PORT_FROM_SYSNAME[probe.sysname] ?? probe.sysname;
  const board = (probe.build || '').split('-')[0].toLowerCase(); // "ESP32_GENERIC-SPIRAM" -> esp32_generic
  const names = [
    ...(board ? [`micropython-${port}-${board}-stubs`] : []),
    ...(port === 'esp32' && !board ? ['micropython-esp32-esp32_generic-stubs'] : []),
    `micropython-${port}-stubs`,
  ];
  const want = probe.version.slice(0, 3);
  let fallback = null;
  for (const name of names) {
    const vs = available[name];
    if (!vs) continue;
    // exact major.minor.patch if published, else the newest published version that is <= the board's
    const parsed = vs.map((v) => ({ v, k: verKey(v), post: parseInt(/post(\d+)/.exec(v)?.[1] ?? '0', 10) }));
    const ok = parsed.filter((p) => cmp(p.k, want) <= 0).sort((x, y) => cmp(y.k, x.k) || y.post - x.post);
    if (ok.length) {
      const exact = cmp(ok[0].k, want) === 0;
      return { package: name, version: ok[0].v, exact, note: exact ? '' : 'nearest older release' };
    }
    // this package starts after the board's firmware (e.g. board package only exists from 1.21): try the next, more generic package
    fallback ??= { package: name, version: parsed.sort((x, y) => cmp(x.k, y.k) || x.post - y.post)[0].v, exact: false, note: 'board older than all published stubs' };
  }
  return fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
````

### 12.6 `fuzz_manifests.mjs` - tier 1 vs tier 2 parity over every upstream manifest

````js
import { evalManifestWithPython, evalManifestStatic } from './mpy_intellisense.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const [,, mpy, lib] = process.argv;
const files = execSync(`find ports extmod -name manifest.py`, { cwd: mpy, encoding: 'utf8' }).trim().split('\n');
let same = 0, diff = 0, pyfail = 0; const rows = [];
for (const f of files) {
  const manifest = path.join(mpy, f);
  const m = /^ports\/([^/]+)\/(?:boards|variants|mcu)\/([^/]+)/.exec(f);
  const port = m ? path.join(mpy, 'ports', m[1]) : null;
  const board = m && fs.statSync(path.dirname(manifest)).isDirectory() ? path.dirname(manifest) : null;
  const pathVars = { MPY_DIR: mpy, MPY_LIB_DIR: lib, PORT_DIR: port, BOARD_DIR: board };
  const a = evalManifestWithPython({ python: 'python3', manifestfile: path.join(mpy, 'tools/manifestfile.py'), manifest, pathVars });
  const b = evalManifestStatic({ manifest, pathVars });
  if (!a.ok) { pyfail++; rows.push(`PYFAIL ${f}: ${String(a.error).split('\n').slice(-2)[0]}`); continue; }
  const ra = JSON.stringify([...new Set(a.roots)].sort()), rb = JSON.stringify([...new Set(b.roots)].sort());
  const ma = JSON.stringify([...a.modules].sort()), mb = JSON.stringify([...b.modules].sort());
  if (ra === rb && ma === mb && a.errors.length === 0) same++; else {
    diff++;
    rows.push(`DIFF ${f}: roots ${a.roots.length} vs ${b.roots.length}; modules ${a.modules.length} vs ${b.modules.length}; py-errors=${a.errors.length} static-warn=${b.errors.length}` +
      (a.errors[0] ? `\n     py: ${a.errors[0].error.slice(0, 140)}` : '') + (b.errors[0] ? `\n     st: ${b.errors[0].error.slice(0, 140)}` : ''));
  }
}
console.log(`manifests=${files.length} identical=${same} different=${diff} python-eval-failed=${pyfail}`);
console.log(rows.join('\n'));
````

### 12.7 `accuracy.mjs` - C-source scan vs runtime `dir()` ground truth

````js
// Compare C-source scan (MP_REGISTER_MODULE tables) with ground truth dir() from the real unix build
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { scanCModule } from './mpy_intellisense.mjs';
const [,, mpsrc, mpbin] = process.argv;
const candidates = ['extmod/modframebuf.c','extmod/modheapq.c','extmod/modhashlib.c','extmod/modjson.c','extmod/modre.c','extmod/modbinascii.c','extmod/modrandom.c','extmod/modtime.c','extmod/moddeflate.c','extmod/modmachine.c','extmod/modplatform.c','extmod/modselect.c','py/modmath.c','py/modcmath.c','py/modgc.c','py/modstruct.c','py/modcollections.c','py/modarray.c','py/modio.c','py/modsys.c','py/modmicropython.c','py/modthread.c','py/modbuiltins.c','extmod/modos.c','extmod/modwebsocket.c','examples/usercmodule/cexample/examplemodule.c'];
let tot = { found: 0, missing: 0, extra: 0 }; const rows = [];
for (const rel of candidates) {
  const f = path.join(mpsrc, rel);
  if (!fs.existsSync(f)) continue;
  const tmp = fs.mkdtempSync('/tmp/scan-'.replace('/tmp', process.env.TMPDIR || '/tmp'));
  fs.copyFileSync(f, path.join(tmp, path.basename(f)));
  let mods;
  try { mods = scanCModule(tmp); } catch (e) { rows.push(`${rel}: SCANNER ERROR ${e.message}`); continue; }
  for (const m of mods) {
    let truth;
    try { truth = JSON.parse(execSync(`${mpbin} -c "import ${m.module}, json; print(json.dumps(dir(${m.module})))"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { rows.push(`${rel}: module ${m.module}: not importable in unix build (skipped)`); continue; }
    const T = new Set(truth.filter((n) => !n.startsWith('__'))), S = new Set(m.names.filter((n) => !n.startsWith('__')));
    const found = [...T].filter((n) => S.has(n)).length, missing = [...T].filter((n) => !S.has(n)), extra = [...S].filter((n) => !T.has(n));
    tot.found += found; tot.missing += missing.length; tot.extra += extra.length;
    rows.push(`${m.module.padEnd(12)} runtime=${String(T.size).padEnd(3)} scanned=${String(S.size).padEnd(3)} recall=${found}/${T.size} missed=[${missing.join(',')}] notInBuild=[${extra.slice(0,6).join(',')}${extra.length>6?'...':''}]`);
  }
}
console.log(rows.join('\n'));
console.log(`TOTAL runtime-names found=${tot.found} missed=${tot.missing} (recall ${(100*tot.found/(tot.found+tot.missing)).toFixed(1)}%), scanned-but-absent-in-this-build=${tot.extra} (conditional #if entries)`);
````

### 12.8 `test_pick.mjs` - stub package picker table test

````js
import fs from 'node:fs';
import { pickStubPackage } from './mpy_intellisense.mjs';
const available = JSON.parse(fs.readFileSync(new URL('../pypi_versions.json', import.meta.url)));
const cases = [
  ['ESP32 WROOM, MP 1.26.0, build=ESP32_GENERIC',        { sysname: 'esp32', build: 'ESP32_GENERIC', version: [1, 26, 0] }],
  ['ESP32 WROOM, SPIRAM variant',                         { sysname: 'esp32', build: 'ESP32_GENERIC-SPIRAM', version: [1, 27, 0] }],
  ['ESP32-S3, MP 1.28.0',                                 { sysname: 'esp32', build: 'ESP32_GENERIC_S3', version: [1, 28, 0] }],
  ['old firmware (no _build), MP 1.19.1',                 { sysname: 'esp32', build: '', version: [1, 19, 1] }],
  ['preview build 1.30.0-preview (newer than any stubs)', { sysname: 'esp32', build: 'ESP32_GENERIC', version: [1, 30, 0] }],
  ['MP 1.24.0 (stubs only publish 1.24.1)',               { sysname: 'esp32', build: 'ESP32_GENERIC', version: [1, 24, 0] }],
  ['Pico W, MP 1.26.1',                                   { sysname: 'rp2', build: 'RPI_PICO_W', version: [1, 26, 1] }],
  ['custom board "MYLAB_ESP32" (no board package)',       { sysname: 'esp32', build: 'MYLAB_ESP32', version: [1, 26, 0] }],
  ['pyboard (stm32 port, sysname=pyboard)',               { sysname: 'pyboard', build: 'PYBV11', version: [1, 25, 0] }],
];
for (const [label, probe] of cases) console.log(label.padEnd(56), '->', JSON.stringify(pickStubPackage(probe, available)));
````

### 12.9 `lsp_precedence.mjs` - drive pyright-langserver like VS Code to test settings vs config precedence

````js
// Drive pyright-langserver (stdio) like VS Code would, to observe how VS Code-style settings
// (python.analysis.*) interact with a pyrightconfig.json.  Usage:
//   node lsp_precedence.mjs <langserver.js path> <project dir> '<settings json>'
// Prints the diagnostics published for main.py.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , server, projectDir, settingsJson] = process.argv;
const settings = JSON.parse(settingsJson || '{}'); // e.g. {"python":{"analysis":{"extraPaths":["lib_a"]}}}
const root = path.resolve(projectDir);
const rootUri = pathToFileURL(root).toString();

const child = spawn('node', [server, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const diagnostics = new Map();

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}
const request = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); send({ id, method, params }); });
const notify = (method, params) => send({ method, params });

function pick(obj, section) {
  return section.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString());
    buf = buf.slice(sep + 4 + len);
    if (msg.id !== undefined && msg.method === undefined) { pending.get(msg.id)?.(msg.result); pending.delete(msg.id); }
    else if (msg.method === 'workspace/configuration') {
      send({ id: msg.id, result: msg.params.items.map((it) => pick(settings, it.section) ?? null) });
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      diagnostics.set(msg.params.uri, msg.params.diagnostics);
    } else if (msg.id !== undefined) {
      send({ id: msg.id, result: null }); // client/registerCapability etc.
    }
  }
});

const main = path.join(root, 'main.py');
const initRes = await request('initialize', {
  processId: process.pid,
  rootUri,
  workspaceFolders: [{ uri: rootUri, name: 'proj' }],
  capabilities: { workspace: { configuration: true, didChangeConfiguration: { dynamicRegistration: true }, workspaceFolders: true },
    textDocument: { publishDiagnostics: { relatedInformation: true } } },
  initializationOptions: {},
});
notify('initialized', {});
notify('workspace/didChangeConfiguration', { settings });
notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(main).toString(), languageId: 'python', version: 1, text: fs.readFileSync(main, 'utf8') } });

await new Promise((r) => setTimeout(r, 4500));
const d = diagnostics.get(pathToFileURL(main).toString()) ?? [];
const sev = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
console.log(`  diagnostics for main.py (${d.length}):`);
for (const x of d) console.log(`   L${x.range.start.line + 1} ${sev[x.severity]} ${x.code ?? ''} ${x.message.split('\n')[0].slice(0, 100)}`);
send({ id: nextId++, method: 'shutdown' });
notify('exit', null);
setTimeout(() => process.exit(0), 300);
````

---------------------------------------------------------------------------------------------------------------

## Follow-up: Complaint 2 on the user's real firmware

Date 2026-10-12. Role: follow-up investigator for the gap named in `10-completeness-critic.md` (section 2.2 and gap 2): "07 proved the mechanism only on an invented firmware."
Host: macOS 24.6 (darwin x64), Node 26.5, Python 3.15.0, **pyright 1.1.414** (not Pylance). Evidence tags as above: **[E]** executed and observed now, **[R]** read in source/build artifacts, **[I]** inference, **[U]** unverified.

Abbreviations: `$FW` = `<course firmware repo>` (the user's firmware repo, MicroPython v1.29.0 submodule at `lib/micropython`); `$SP` = the session scratchpad (`.../scratchpad`), work in `$SP/real/`.
Safety: no serial port was opened and nothing was run against the plugged-in board. Everything below ran on the host. The firmware repo was used read-only, with one slip that I cleaned up: my first tier-1 run created `$FW/lib/micropython/tools/__pycache__/manifestfile.cpython-315.pyc` (git-ignored; I deleted that single file; the two `cpython-313.pyc` files next to it are from the firmware's own build and were left alone). The slip is itself a finding (section F.7). A `find -newer` check after the final runs shows zero changed files in `$FW`. `~/src/mpy_test` was not modified; every "before/after" run used a copy of its `test.py`/`boot.py`.

### F.0 Answers, short

1. **Does `$(BOARD_DIR)/..` resolve?** Yes, but only when `BOARD_DIR` is the directory that contains the manifest (`$FW/boards/WSU_SHIELD`): `$(BOARD_DIR)/../../python` is then `$FW/python`, which is the root of the frozen `shield` package [E]. It does **not** resolve with the rule 07 proposed for `BOARD_DIR` ("`ports/<port>/boards/<_build>`", sections 6.1 and 9.5 above): that gives `lib/micropython/ports/esp32/boards/WSU_SHIELD`, which does not exist, and `package("shield", ...)` then points at `lib/micropython/ports/esp32/python`, which does not exist either. Tier 1 reports an ENOENT (soft), tier 2 reports nothing and emits the dead root [E]. The firmware's own build passes `-v BOARD_DIR=$FW/boards/WSU_SHIELD` to `makemanifest.py` (`$FW/build/build_WSU_SHIELD.log:13`) [R], so the correct rule for an out-of-tree board is "`BOARD_DIR` = `dirname(manifest.py)`", which the prototype below derives with no user input.
2. **Does `_build == 'WSU_SHIELD'` fall back to `micropython-esp32-stubs`?** Yes [E]. `pickStubPackage({sysname:'esp32', build:'WSU_SHIELD', version:[1,29,0]}, <real PyPI index>)` returns `micropython-esp32-stubs 1.29.0.post1`, exact version match. Why `_build` is `WSU_SHIELD` and not `ESP32_GENERIC`: `ports/esp32/Makefile:11` `BOARD ?= $(notdir $(BOARD_DIR:/=))` and `:52` `-D MICROPY_BOARD=$(BOARD)` -> `py/mkrules.cmake:26-35` defines `MICROPY_BOARD_BUILD_NAME="WSU_SHIELD"` -> `py/modsys.c:104-105` exposes it as `sys.implementation._build`. Confirmed in the built artifacts: `build/WSU_SHIELD/CMakeCache.txt:357` `MICROPY_BOARD:UNINITIALIZED=WSU_SHIELD` and `compile_commands.json` contains `MICROPY_BOARD_BUILD_NAME=\"WSU_SHIELD\"` [R]. I did **not** read it from the live board (forbidden); the live value is [I] from the build artifacts. The fallback package is content-identical to `micropython-esp32-esp32_generic-stubs 1.29.0.post1` (I downloaded both wheels and diffed: only `README.md` and `pyproject.toml` differ) [E], so which of the two is chosen does not matter for this board; 07's picker does return different names for "custom `_build`" (`micropython-esp32-stubs`) and "`_build` absent" (`...esp32_generic-stubs`), which is harmless but untidy.
3. **What must the instructor ship so students (no firmware repo) get `shield` and `_shield` resolved?** Section F.6. In one line: a **29 KB `course-stubs/` folder** (the four frozen `shield/*.py` files copied verbatim + a generated `_shield.pyi`) plus a pyright config that puts it on `extraPaths`, marks it `ignore`, and a sync-ignore entry so it is not uploaded to the board. Students need nothing else beyond the stock stubs that the extension bundles; no firmware repo, no MicroPython checkout, no micropython-lib submodule, no Python for manifest evaluation, no network.

### F.1 What the real firmware looks like (all [R], line numbers in `$FW`)

| Fact | Where |
|---|---|
| Manifest is two statements: `include("$(PORT_DIR)/boards/manifest.py")` and `package("shield", base_path="$(BOARD_DIR)/../../python")`. No `c_module()` call. | `boards/WSU_SHIELD/manifest.py:2,5` |
| The manifest is wired in by the board: `set(MICROPY_FROZEN_MANIFEST ${MICROPY_BOARD_DIR}/manifest.py)` | `boards/WSU_SHIELD/mpconfigboard.cmake:35` |
| The C module is wired in **by the board's cmake, not by the manifest**: `set(USER_C_MODULES ${SHIELD_UPY_DIR}/cmodules/shield/micropython.cmake)` with `SHIELD_UPY_DIR` from `get_filename_component(... ${MICROPY_BOARD_DIR}/../.. ABSOLUTE)` | `mpconfigboard.cmake:25,28-30` |
| `_shield` module table has 49 entries (48 plus `__name__`), **no `#if` anywhere in it**, registered with `MP_REGISTER_MODULE(MP_QSTR__shield, shield_user_cmodule)` | `cmodules/shield/mod_shield.c:571-627, 634` |
| Entry kinds: 21 `MP_ROM_INT` consts, 26 functions via `static MP_DEFINE_CONST_FUN_OBJ_{0,1,2,3,VAR_BETWEEN}`, and `__version__` as `static MP_DEFINE_STR_OBJ(shield_version_obj, SHIELD_VERSION_STR)` | `mod_shield.c:209-624, 569` |
| The frozen package imports `_shield` in all four files (`__init__.py:14`, `motor.py:12`, `servo.py:14`, `pins.py:5`) and refuses to import on an ABI mismatch | `python/shield/*.py`, `__init__.py:16-19` |
| The real firmware build ran `makemanifest.py` with `BOARD_DIR=$FW/boards/WSU_SHIELD`, `MPY_DIR=$FW/lib/micropython`, `MPY_LIB_DIR=$FW/lib/micropython/lib/micropython-lib`, `PORT_DIR=$FW/lib/micropython/ports/esp32` | `build/build_WSU_SHIELD.log:13` |
| The firmware's own frozen module list (ground truth for the manifest evaluators): 32 frozen files = 23 top-level modules | `build/WSU_SHIELD/frozen_content.c:31435-31466` |
| `sys.path` on the board is `['', '.frozen', '/lib']` (so a stray `/shield/` on the flash would shadow the frozen package) | `lib/micropython/py/runtime.c:148-150`, `ports/esp32/main.c:144` |
| `v1.29.0` `manifestfile.py` already has `c_module()` (so 07's "new in 2026" is right), but this manifest does not call it | `lib/micropython/tools/manifestfile.py:522` |
| Board name strings are `MICROPY_HW_BOARD_NAME "WSU Motor Shield"` / `MICROPY_HW_MCU_NAME "ESP32"`; `esp32.PCNT` is off and Bluetooth is off | `boards/WSU_SHIELD/mpconfigboard.h:4-5,9,13` |

The student program `~/src/mpy_test/test.py` imports `select, sys, time, shield` and uses `time.ticks_ms/ticks_diff/ticks_add/sleep_ms`, `select.poll`, `shield.Motor/Servo/run`.

### F.2 Complaint 2 reproduced on the user's own program [E]

pyright 1.1.414 on a copy of `test.py` (+`boot.py`), project root = that copy, `$SP/real/before`:

| Config | Diagnostics on `test.py` |
|---|---|
| none (CLI default `standard`) | **6 errors**: `Import "shield" could not be resolved` (:18) and 5x `"ticks_ms" / "ticks_diff" / "ticks_add" / "sleep_ms" is not a known attribute of module "time"` (:53, :84-86, :90) |
| `typeCheckingMode: off` (= Pylance's default; the user's User settings contain only `python.languageServer: Pylance` and an empty `defaultInterpreterPath`, and `~/src/mpy_test/.vscode/settings.json` has only `mpyWorkbench.pythonPath`) | **1 warning**: `Import "shield" could not be resolved` (:18). The five `time.*` problems are silent in `off` mode. |

So what a student (or the instructor) sees with the old extension and default Pylance is exactly the reported symptom: a yellow squiggle on `import shield`, no completion or hover for `shield.Motor`, and (once the course raises the checking mode) red `time.sleep_ms`. The old extension contributes nothing here (07 section 1). **Root cause for the user's case: confidence high (>=90%).** It is the "missing feature" of 07 section 1, narrowed: there is no import root for the frozen package `shield` anywhere on the student's machine (the package lives only in the firmware repo and inside the board's flash), and no stubs/config exist. Refute/verify in VS Code: open `mpy_test/test.py`, run "Python: Show Language Server Output"; the search-path list will contain no directory holding a `shield` package. Not run: Pylance itself (licence), so the squiggle colour in Pylance is [R] (`reportMissingImports` is `warning` in `off` mode) plus the pyright CLI run above.

### F.3 Running 07's prototypes on the real manifest [E]

Prototype = `$SP/proto/tool/mpy_intellisense.mjs` exactly as inlined in 12.5 (unchanged), output projects in `$SP/real/v*`. Inputs: `--manifest $FW/boards/WSU_SHIELD/manifest.py --mpy-dir $FW/lib/micropython --mpy-lib $FW/lib/micropython/lib/micropython-lib`; stock stubs = the unpacked `micropython-esp32-stubs 1.29.0.post1` wheel.

| Run | `--port-dir` / `--board-dir` | Tier | `shield` root found | cModules | pyright on `test.py` (basic config via `extends`) |
|---|---|---|---|---|---|
| v1 naive (`--fw $FW`, no `--manifest`) | none | static | no (`$FW/manifest.py` does not exist; the manifest is under `boards/WSU_SHIELD/`) | 0 | n/a (no config content) |
| v2 no path variables | none | python | no: 2 soft errors (`include('$(PORT_DIR)/boards/manifest.py')` ENOENT; `package('shield')` ENOENT `.../boards/python`) | 0 | 1 error: `shield` unresolved (stock stubs only: `time.ticks_*` fixed) |
| v3 07's rule for a board id (`ports/esp32`, `ports/esp32/boards/WSU_SHIELD`) | wrong | python | no: ENOENT `.../ports/esp32/python` (22 stock modules found, no `shield`) | 0 | 1 error: `shield` unresolved |
| v3s same, tier 2 | wrong | static | **lists `shield` as frozen, no error, and writes the non-existent root `.../ports/esp32/python` into `extraPaths`** (`package()`/`module()` roots are not existence-checked, `freeze()` roots are, section 12.5 `evalManifestStatic`) | 0 | n/a |
| v4 correct (`ports/esp32`, `boards/WSU_SHIELD`) | right | python | **yes**: root `$FW/python` | **0** | **0 diagnostics on `test.py`**; `shield` resolves, `Motor` is `Motor` |
| v5 correct, tier 2 | right | static | yes, same root | **0** | same |

* Both tiers, with correct variables, return exactly the module set of the firmware's own `frozen_content.c`: 23 top-level modules (`_boot aioespnow apa106 asyncio dht ds18x20 espnow flashbdev inisetup machine mip neopixel ntptime onewire requests shield ssl uasyncio umqtt upysh urequests webrepl webrepl_setup`), set-equal [E]. That is the first parity check against a *real* build output instead of another evaluator, and it extends 07 section 6.1's 99/99 (evaluator vs evaluator).
* **The prototype generated no `_shield.pyi` in any run (cModules = 0).** 07 finds C modules only through `c_module()` calls in the manifest (`res.cModules`, section 12.5 `main`). This firmware declares its C module through `USER_C_MODULES` in `mpconfigboard.cmake`, so the manifest has none. The scanner itself works (next section); it is just never pointed at `cmodules/shield`.

### F.4 The C scanner on the real `mod_shield.c`, against the unix simulator [E]

Scanner run directly on `$FW/cmodules/shield` produced `_shield.pyi` (48 names; 1760 bytes). Ground truth: `tools/build_unix.sh` with `BUILD=$SP/real/unix-build` (rc 0, `_shield ABI 1 2930580-dirty`; the script's own submodule-unchanged check passed; the repo's old `build/unix/micropython` from Sep 24 also exists and gives the identical 51-name `dir(_shield)`).

* **Correction to `10-completeness-critic.md` section 2.2** (`build/unix/` "holds objects ... no `micropython` binary present"): `$FW/build/unix/micropython` exists (448,296 bytes, executable, Sep 24 17:04) and runs [E]. The rebuild was still useful (fresh, scratchpad-only), but a hardware-free ground truth was available all along.
* Runtime `dir(_shield)` = 51 names; minus the 3 implicit dunders (`__class__`, `__dict__`, `__name__`) = 48. Stub names = 48. **Recall 48/48, extras 0.** The module table has no `#if` guards (`mod_shield.c:571-626`), so the unix-port table equals the board's table [R]; the lifecycle hooks and `shield_board_startup` are not table entries.
* Constants: all 21 `int` consts are `int` at runtime, and the stub declares them `int` [E]. **`__version__` is the one miss in quality**: the scanner emits `__version__: Any  # unresolved: MP_ROM_PTR(&shield_version_obj)` because `MP_DEFINE_STR_OBJ` is not understood; runtime type is `str`. One-regex fix (`MP_DEFINE_STR_OBJ(name, ...)` -> `str`).
* Arity, measured on the simulator by calling every function with `None` x n and classifying the TypeError (`introspect_arity.py`, F.9): 22 of the 26 functions have exactly the arity the stub states. The other four, the `VAR_BETWEEN` ones, are emitted as `*args: Any` (accepts a superset, never a false error): `motors_begin` (runtime 7..9), `motor_gains` (1..4), `servo_freq` (0..1), `exception_policy` (0..1). Parameter names come from the C parameter lists (`m`, `counts`, `inv_motor`, `inv_enc`, `slot`, `us`, `gpio`) and are right; most types are `Any` because the C code converts through the file's own helpers (`arg_i32`, `arg_float`, `motor_arg`), not `mp_obj_get_int(param)`, so 07's type-guessing finds only `bool` for `motor_direction`.
* Return types vs runtime: `motors_ready -> bool`, `stats/hook_counts/motor_status/motors_config -> tuple` (lengths 5/3/6/9 lost, `tuple[Any, ...]`), `servo_get_us -> int`, `servo_freq -> int | None`, `exception_policy -> Any`: no contradiction with any observed runtime value [E].
* Which pyright answers change with `_shield.pyi` (probe file, `$SP/real/probe.py`): `import _shield` resolves; `_shield.ABI` is `int` instead of `Unknown`; `shield.__version__` is `Any` instead of `Unknown`; `Motor.position()` goes from `Unknown | None` to `Any | Unknown | None`. **`import shield` and every name of the student API resolve without `_shield.pyi`**: pyright does not report diagnostics inside library code, and unresolved imports there just make derived types `Unknown` [E]. Cross-check of the Python layer: the 15 names in the simulator's `dir(shield)` (`MICROPYPATH=$FW/python`) all resolve via `from shield import <name>` (0 errors) [E].
* Instructor-side corollary: if the instructor opens `$FW/python/` itself as a project, pyright reports 4 errors `Import "_shield" could not be resolved` (`__init__.py:14`, `motor.py:12`, `pins.py:5`, `servo.py:14`); with `_shield.pyi` they disappear, and 9 genuine pyright findings in `motor.py`/`servo.py` remain (list inferred as `list[None]` at `motor.py:188,231`, `servo.py:61`; Optional subscripts at `motor.py:288`, which only appear once `_shield` is typed) [E].

### F.5 Pipeline on the real firmware, with the fixes [E]

`$SP/real/tool_B/` = the 12.5 generator plus two new files (inlined in F.9): `discover.mjs` (derives `BOARD_DIR`, `MPY_DIR`, `PORT_DIR`, `MPY_LIB_DIR` from the manifest location, and `USER_C_MODULES` from `mpconfigboard.cmake` with a 15-line CMake evaluator) and `run_real.mjs` (discover -> tier 1 with `python -B -I` -> export exactly the frozen user files -> scan `USER_C_MODULES` -> write configs). Input: only the manifest path and the stock-stub directory. 0.47 s including the stock-stub unpack.

Discovery output [E]: `boardDir=$FW/boards/WSU_SHIELD`, `mpyDir=$FW/lib/micropython`, `portDir=.../ports/esp32` (from `IDF_TARGET` in `mpconfigboard.cmake`), `mplib=.../lib/micropython-lib`, `USER_C_MODULES -> $FW/cmodules/shield` (exactly one). The tempting alternative, "glob the repo for `micropython.cmake`/`micropython.mk`", returns **two** dirs: the second is `docs/research/prototype-2026-09-23/cmodules/me401`, which the firmware's `CLAUDE.md:26` calls "reference only, do not copy". A glob would have generated a stub for a module that is not in the firmware. So the authoritative source is `USER_C_MODULES` (cmake) / `USER_C_MODULES=` (make line in `tools/build_unix.sh:44`), with a user-visible pick list.

Result (project `$SP/real/G_fixed_pipeline`, config `extends` the generated file, `typeCheckingMode: basic`): **`test.py` 0 diagnostics** (was 6 errors / 1 warning), `probe.py` exactly the two intended errors (`m.bogus()`, `shield.nonexistent_function()`). Exported files: `course-stubs/shield/{__init__,motor,pins,servo}.py` + `course-stubs/_shield.pyi`.

### F.6 What the instructor must ship, and what students must not get

Student machine, no firmware repo, no network, no board needed for IntelliSense:

```
<workspace>/                          (the folder that mirrors the board root)
  pyrightconfig.json                  user-owned, 3 keys: extends / typeCheckingMode: basic / reportMissingModuleSource: none
  .mpy-workbench/pyright.generated.json   {pythonPlatform: Linux, stubPath: stubs/active, extraPaths: ["../course-stubs"], ignore: ["../course-stubs"]}
  .mpy-workbench/stubs/active/        stock ESP32 1.29.0 stubs, unpacked by the EXTENSION from its own bundle (767 kB, 129 files)
  course-stubs/                       THE INSTRUCTOR'S DELIVERABLE (29,103 bytes)
    shield/__init__.py motor.py pins.py servo.py     verbatim copies of $FW/python/shield at the firmware's commit
    _shield.pyi                                       generated from cmodules/shield/mod_shield.c
```
Verified as a self-contained pack in `$SP/real/F2_ignore` (all config paths relative, none outside the project; `grep me401` finds nothing): `test.py` 0 diagnostics, `shield` resolves, wrong calls are flagged [E].

Rules that the experiments established:

1. **Ship the Python sources, not `.pyi` made from them.** `pyright --createstub shield` writes `from .motor import Encoder, Motor, config` into `shield/__init__.pyi`; in a stub file that is not a re-export, so `shield.Motor` and `shield.Servo` become `"Motor" is unknown import symbol` / `"Motor" is not a known attribute of module "shield"` (10 errors in the variant `$SP/real/F3_pyi`) [E]. Sources also keep the docstrings that power hover. If `.pyi` is wanted, generate it with `import X as X` / `__all__` re-exports.
2. **Mark the pack `ignore` in pyright config.** Without `"ignore": ["../course-stubs"]`, pyright treats the pack as project code and reports the 9 findings of F.4 inside `motor.py`/`servo.py` (`$SP/real/F_student_pack`: 11 errors); with it, 2 (the intended ones) [E]. `ignore` is parsed by Pylance's bundled engine (`configObj.ignore` in `pyright.bundle.js`) [R].
3. **Keep the pack out of the board mirror.** The workspace root mirrors the board root. The old default ignore list (`mpy-workbench/src/sync.ts:73-85`) and the user's real `~/src/mpy_test/.mpy-workbench/.mpyignore` do not contain `course-stubs/`, `pyrightconfig.json` or `typings/`, so auto-sync would upload them (29 KB of flash, plus config) [R]. Worse, `''` is the first `sys.path` entry (`runtime.c:148-150`), so a `shield/` that ends up in the board root or `/lib` shadows the frozen package [R/I]. The new extension's default ignore list must contain `course-stubs/`, `pyrightconfig.json`, `typings/`.
4. **Stock stubs come from the extension's bundle**, version picked from `sys.implementation` (here `v1.29.0` -> `micropython-esp32-stubs 1.29.0.post1`). They over-approximate this board: `bluetooth.pyi` and `esp32.PCNT` exist in the stubs but are compiled out (`mpconfigboard.h:9,13`), so `import bluetooth` resolves in the editor and fails on the board. That is a missed error, not a false one, and an instructor overlay cannot remove a stock name.
5. **Stamp the pack** with `{firmware git describe, SHIELD_ABI, MicroPython tag, _build}`. The firmware embeds all of them (`shield_version.h`: `SHIELD_VERSION_STR "2930580-dirty"`, `SHIELD_ABI 1`; `_shield.__version__`, `_shield.ABI`; `sys.implementation._build`), so the extension can compare the pack with the connected board and say "course stubs are for firmware X, your board has Y". Note the current build is `-dirty`, i.e. not reproducible from a commit; the instructor should release from a clean tag.
6. Instructor workflow: regenerate the pack whenever `python/shield/**` or `cmodules/shield/*.c` changes (the extension's file watcher on those two paths, or a `tools/` step in the firmware repo's build script that calls the generator), commit `course-stubs/` to the course template, and set the template's `mpyWorkbench.intellisense.autoConfigure: always`.

### F.7 Where this evidence contradicts or corrects earlier notes

* **07 sections 6.1 / 9.5 (`PORT_DIR`/`BOARD_DIR` "from the board identity `ports/<port>/boards/<_build>`")**: wrong for any out-of-tree board such as WSU_SHIELD (v3 above). Use `dirname(manifest.py)` when it contains `mpconfigboard.*`; confirmed by the firmware's own `makemanifest.py` command line.
* **07 sections 6.2 / 12.5 (C modules found via `c_module()`)**: yields zero C modules on this firmware. `c_module()` exists in v1.29.0 (`manifestfile.py:522`) but this board's manifest does not use it. Needs a second source: `USER_C_MODULES` from `mpconfigboard.cmake` (or an explicit setting).
* **07 sections 6.1 / 12.1 (tier 1 "`python -I` ... safe")**: `-I` does not stop Python writing `__pycache__` next to the imported `manifestfile.py`; it wrote one into the firmware's `lib/micropython/tools/__pycache__` [E]. On a read-only tree it would silently not cache; on OneDrive/Windows it creates a stray file in the instructor's repo. Use `python -B -I` (verified: zero files written to `$FW`).
* **07 section 12.5 (`evalManifestStatic`)**: `package()`/`module()` roots are not checked for existence, so a wrong `BOARD_DIR` yields a silent dead `extraPaths` entry and a report that claims `shield` is covered (v3s). Add the same existence check `freeze()` has and surface it as an error in the report.
* **07 section 9.8 ("Export Course Stubs")**: correct in intent, but as designed it would flood the pack with pyright findings (rule F.6.2) and could break the API if implemented via `--createstub` (rule F.6.1).
* **07 sections 3.2/9.2 are not contradicted**: `extends` + generated environment file + user-owned config worked unchanged on this firmware with pyright; the parts not executed in Pylance remain [U].
* **10-completeness-critic section 2.2**: "no `micropython` binary present" is wrong (see F.4). Its statement that complaint 2 was "unverified for the user's real case" was right and is now closed to the extent F.2 and F.5 show.
* **07 gap 13.2** (exact version/board of the class firmware): now known. MicroPython v1.29.0 (git tag, exact), ESP-IDF 5.5.4, `_build = WSU_SHIELD`, 23 frozen top-level modules, one C module `_shield`, ABI 1.

### F.8 Confidence, limits, and how to verify

| Claim | Confidence | Basis | Refute / verify by |
|---|---|---|---|
| Complaint 2 on the user's case = no import root for `shield` + no stubs/config (plus `time.ticks_*` once checking is `basic`) | high (>=90%) | [E] pyright CLI on copies of the user's files; [R] Pylance defaults | VS Code "Python: Show Language Server Output" on `mpy_test`: no `shield` root in the search paths |
| Corrected pipeline resolves `shield` and `_shield` and flags wrong calls, with no firmware repo on the student side | high for pyright 1.1.414; medium-high for Pylance 2026.4.1 | [E] CLI; [R] Pylance bundle parses `extends`, `ignore`, `stubPath` | In VS Code with Pylance: open the student pack, hover `shield.Motor`, check the search-path log and that `course-stubs/shield/motor.py` shows no squiggles |
| Evaluators match the firmware's real frozen set | high | [E] set equality with `frozen_content.c` (tiers 1 and 2) | re-run after any manifest change |
| `_shield.pyi` names match the board | high for names/consts and for the arity of 22 of 26 functions (the other 4 are `*args`); types mostly `Any` | [E] against the rebuilt unix simulator; table has no `#if` | `dir(_shield)` on the board through mpremote (read-only; not done here: no serial access) |
| Live board reports `_build == 'WSU_SHIELD'` | high but [I] | build artifacts + Makefile/cmake source | one `mpremote exec` of `print(sys.implementation._build)` on the board, by a human |
| The board on the instructor's desk runs this exact build | unknown | the repo's `build/WSU_SHIELD` is Sep 24; I cannot read the board | `shield.__version__` vs `2930580-dirty` |

Not done: Pylance itself (licence); Windows (the pack contains only relative forward-slash paths, but the absolute-path form that the instructor-side config uses when `$FW` is on another drive is untested); the extension's `Export`/`Import` UX; hardware.

### F.9 Reproduction record and new sources

All under `$SP/real/` (session-temporary): `before/ A_none/ A_off/ v1..v5, v3s, v4B/ E_v4_plus_cmod/ F_student_pack/ F2_ignore/ F3_pyi/ G_fixed_pipeline/ H_instructor/` (pyright projects), `scan_out/_shield.pyi`, `unix-build/` (simulator), `runtime_shield.json`, `tool_B/` (patched generator + new files), `probe.py`, `diag.py`.
Commands: `BUILD=$SP/real/unix-build bash $FW/tools/build_unix.sh`; `node $SP/real/tool_B/run_real.mjs $FW/boards/WSU_SHIELD/manifest.py <project> <unpacked stock stubs>`; `cd <project> && $SP/pyright-env/node_modules/.bin/pyright --outputjson | python3 -I $SP/real/diag.py`. The one-line generator patch: in `evalManifestWithPython`, `['-I', ...]` -> `['-B', '-I', ...]`.

`tool_B/discover.mjs` (new; the glob part is kept only to document the trap in F.5, `run_real.mjs` does not use it):

````js
// Zero-input discovery of the manifest path variables and the C-module dirs from a custom-board firmware repo.
import fs from 'node:fs';
import path from 'node:path';
const has = (...p) => fs.existsSync(path.join(...p));
export function discoverFirmware(manifest) {
  const manifestDir = path.dirname(path.resolve(manifest));
  const boardDir = ['mpconfigboard.cmake', 'mpconfigboard.mk', 'mpconfigboard.h'].some((f) => has(manifestDir, f)) ? manifestDir : null;
  // walk up for a MicroPython checkout: <dir>/lib/micropython or <dir>/micropython (or the dir itself)
  let mpyDir = null, repoRoot = null;
  for (let d = manifestDir, prev = ''; d !== prev; prev = d, d = path.dirname(d)) {
    for (const cand of [d, path.join(d, 'lib', 'micropython'), path.join(d, 'micropython')]) {
      if (has(cand, 'py', 'mpconfig.h') && has(cand, 'tools', 'manifestfile.py')) { mpyDir = cand; repoRoot = d; break; }
    }
    if (mpyDir) break;
  }
  // port: IDF_TARGET in mpconfigboard.cmake => esp32 (other ports: read MCU_SERIES in mpconfigboard.mk; not implemented)
  let port = null;
  if (boardDir && has(boardDir, 'mpconfigboard.cmake') && /IDF_TARGET/.test(fs.readFileSync(path.join(boardDir, 'mpconfigboard.cmake'), 'utf8'))) port = 'esp32';
  const mplib = mpyDir && [path.join(mpyDir, 'lib', 'micropython-lib')].find((p) => has(p, 'micropython'));
  // TRAP (see F.5): globbing for micropython.cmake/.mk also finds stale prototypes. Authoritative source = USER_C_MODULES below.
  const cmods = new Set();
  const skip = new Set(['.git', 'build', 'node_modules', '.venv', 'lib']);
  const walk = (d, depth) => {
    if (depth > 5) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.isFile() && /^micropython\.(cmake|mk)$/.test(e.name))) cmods.add(d);
    for (const e of ents) if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth + 1);
  };
  const fwRoot = boardDir ? path.dirname(path.dirname(boardDir)) : manifestDir;
  walk(fwRoot, 0);
  return { boardDir, mpyDir, repoRoot, port, portDir: mpyDir && port ? path.join(mpyDir, 'ports', port) : null, mplib, cModules: [...cmods], fwRoot };
}

// Minimal CMake evaluator: `set(V ...)`, `get_filename_component(V expr ABSOLUTE)` and ${V} -- enough to find USER_C_MODULES.
// Limitation: `if(NOT USER_C_MODULES)` guards are ignored (the board file only sets a default); a make-based port needs the make variable instead.
export function userCModulesFromCmake(cmakeFile, boardDir) {
  const vars = { MICROPY_BOARD_DIR: boardDir, CMAKE_CURRENT_LIST_DIR: path.dirname(cmakeFile) };
  const sub = (s) => s.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? `\${${k}}`);
  const src = fs.readFileSync(cmakeFile, 'utf8').replace(/#[^\n]*/g, '');
  const found = [];
  for (const m of src.matchAll(/(set|get_filename_component)\s*\(\s*(\w+)\s+([^)]*?)\s*\)/g)) {
    const [, fn, name, rest] = m;
    if (fn === 'set') { const v = sub(rest.trim().replace(/^"|"$/g, '')); if (name === 'USER_C_MODULES') found.push(v); vars[name] = v; }
    else { const expr = sub(rest.replace(/\s+(ABSOLUTE|DIRECTORY|NAME)\b.*$/, '').trim()); vars[name] = path.resolve(expr); }
  }
  return found.map((p) => (p.endsWith('.cmake') ? path.dirname(p) : p));
}
````

`tool_B/run_real.mjs` (new; needs the 12.5 generator and `manifest_probe.py` (12.1) next to it):

````js
// Corrected end-to-end run: discover -> manifest (tier 1, python -B -I) -> C modules from USER_C_MODULES -> scan -> instructor export + student config.
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { discoverFirmware, userCModulesFromCmake } from './discover.mjs';
import { scanCModule, installStockStubs } from './mpy_intellisense.mjs';
const [,, manifest, outDir, stockStubs] = process.argv;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const d = discoverFirmware(manifest);
const pathVars = { MPY_DIR: d.mpyDir, MPY_LIB_DIR: d.mplib, PORT_DIR: d.portDir, BOARD_DIR: d.boardDir };
const r = spawnSync('python3', ['-B', '-I', path.join(HERE, 'manifest_probe.py'), JSON.stringify({ manifestfile: path.join(d.mpyDir, 'tools/manifestfile.py'), manifest, path_vars: pathVars })], { encoding: 'utf8' });
const j = JSON.parse(r.stdout);
const isUpstream = (p) => p.startsWith(d.mpyDir + path.sep);
const userFiles = j.files.filter((f) => !isUpstream(f.root));
// C modules: authoritative = USER_C_MODULES in mpconfigboard.cmake (+ c_module() calls in the manifest)
const cdirs = [...new Set([...j.c_modules, ...userCModulesFromCmake(path.join(d.boardDir, 'mpconfigboard.cmake'), d.boardDir)])];
const pack = path.join(outDir, 'course-stubs'); fs.rmSync(pack, { recursive: true, force: true }); fs.mkdirSync(pack, { recursive: true });
for (const f of userFiles) { const dst = path.join(pack, f.target_path); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(f.full_path, dst); }
const cmods = [];
for (const c of cdirs) for (const g of scanCModule(c)) { fs.writeFileSync(path.join(pack, g.module + '.pyi'), g.pyi); cmods.push(g.module); }
const cfgDir = path.join(outDir, '.mpy-workbench'); fs.mkdirSync(cfgDir, { recursive: true });
installStockStubs(stockStubs, path.join(cfgDir, 'stubs/active'));
fs.writeFileSync(path.join(cfgDir, 'pyright.generated.json'), JSON.stringify({ pythonPlatform: 'Linux', ignore: ['../course-stubs'], stubPath: 'stubs/active', extraPaths: ['../course-stubs'] }, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'pyrightconfig.json'), JSON.stringify({ extends: '.mpy-workbench/pyright.generated.json', typeCheckingMode: 'basic', reportMissingModuleSource: 'none' }, null, 2) + '\n');
console.log(JSON.stringify({ discovered: { ...d, cModules: undefined }, manifestErrors: j.errors, userFilesExported: userFiles.map((f) => f.target_path), cModuleDirs: cdirs, cModulesGenerated: cmods }, null, 1));
````

`introspect_arity.py` (run with the rebuilt unix binary; calls every `_shield` function with `None` x n for n = 0..11 and keeps the n values that do not raise an arity TypeError; it touches only the simulated hardware layer and the `None` arguments make every body fail at argument conversion, so no state changes):

````python
import _shield, json
out = {}
for name in dir(_shield):
    if name.startswith('__') and name.endswith('__'):
        continue
    o = getattr(_shield, name)
    kind = type(o).__name__
    ok = []
    if kind == 'function':
        for n in range(0, 12):
            try:
                o(*([None] * n))
            except TypeError as e:
                if 'positional argument' in str(e) or 'expected at most' in str(e) or ('takes' in str(e) and 'given' in str(e)):
                    continue
                ok.append(n)
            except Exception:
                ok.append(n)
            else:
                ok.append(n)
    out[name] = {'kind': kind, 'nargs': ok}
    if kind in ('int', 'str', 'bool'):
        out[name]['value'] = o
print(json.dumps(out))
````

---------------------------------------------------------------------------------------------------------------

## Follow-up: Real Pylance verification and IntelliSense file-layout contract

Date 2026-10-12. Role: follow-up investigator for the gap "07 admits the one thing it could not execute is Pylance's own precedence" (`10-completeness-critic.md` section 9 gap 8; `09-architecture-options.md` spike S-04 and decision D-05 "layout DECIDED (design); default confirmed or flipped by SPIKE S-04").
Evidence tags as above: **[E]** executed and observed now, **[R]** read in source/docs, **[I]** inference, **[U]** unverified. Everything in P.2 is [E] unless tagged otherwise.
Safety: no serial port was opened, nothing was run against the plugged-in board, nothing was installed globally. The user's running VS Code was not touched: every run used a separate Electron instance with its own `--user-data-dir` and `--extensions-dir` inside the scratchpad. The firmware repo and `~/src/mpy_test` were not written. The instructor's OneDrive course folder was not opened or listed (a request to list it was refused by the permission layer in note 10; I did not try again).

### P.0 Answers, short

1. **Real Pylance 2026.4.1 was executed** [E]: VS Code 1.141.0 (macOS, Electron), `ms-python.vscode-pylance` 2026.4.1 (its log says `pyright version 1.1.414, commit 0653de23`, i.e. the same engine version that 07 tested through `pyright-langserver`), `ms-python.python` 2026.8.0, `ms-python.vscode-python-envs` 1.38.0, copied (APFS clone) from the user's `~/.vscode/extensions` into a scratch extensions directory. A tiny probe extension (P.6) opened files, waited for the server, and recorded `vscode.languages.getDiagnostics`, Go to Definition, hover and completion results; the "Python Language Server" log at `python.analysis.logLevel: Trace` supplied the effective config files, `Extra paths`, `Python platform` and `Search paths`. 42 launches (including a few calibration runs), 22-50 s each.
2. **07's design works unchanged in real Pylance** [E]: `pyrightconfig.json` (user-owned) -> `extends` -> `.mpy-workbench/pyright.generated.json` (`pythonPlatform`, `ignore`, `stubPath`, `extraPaths`) with `stubPath` pointing into a dot-directory. On the real-firmware student pack (`$SP/real/F2_ignore` of the previous gap, plus a `lib/` module and a probe file) Pylance resolved `import shield` to `course-stubs/shield/__init__.py`, `import _shield` to `course-stubs/_shield.pyi`, `time.sleep_ms` to `.mpy-workbench/stubs/active/time.pyi:284`, `machine.Pin` to `.../machine.pyi:1347` (hover shows the MicroPython signature), `shield.` completion lists `Motor, Servo, run, stats, ...`, the user's `test.py` has 0 diagnostics, and exactly the 5 intended errors appear in the probe (unknown module, two attribute errors on `shield`/`Motor`, a missing argument to `_shield.motor_setpoint`, an unknown attribute of `mylib`).
3. **Precedence between `.vscode/settings.json` and a config file in Pylance 2026.4.1 equals what 07 section 3.2 measured on pyright-langserver** [E], with one new fact: with any config file present, `python.analysis.typeCheckingMode`, `stubPath` and `diagnosticSeverityOverrides` from settings are ignored entirely; `python.analysis.extraPaths` is used only when the config (including everything it `extends`) has no `extraPaths` key; a config `extraPaths` replaces the settings list. Details in P.2.1.
4. **The extends target is watched** [E]: rewriting only `.mpy-workbench/pyright.generated.json` (in place, or atomically via a `.tmp` file and rename) makes Pylance log `Received fs event ... for config file` within about 0.3 s and reload both files about 0.1 s later, with no language-server restart; new or changed stub, `course-stubs` and `lib` files are also picked up live, and an `extraPaths` directory that does not exist yet is picked up when it is created. 07 section 9.5 step 6 ("prompt to reload only if it did not pick the change up") can be reduced to "never restart".
5. **`typings/` versus the dot-directory is settled in favour of the dot-directory** (P.2.5, P.2.6): a visible `typings/` works for stock stubs but (a) is uploaded to the board by the old extension's sync (executed: 130 files, 787,235 bytes), (b) floods the Problems panel in `diagnosticMode: workspace` (62 stub files, 59 errors/warnings, 332 diagnostics including hints; the dot-directory layout: 0), (c) cannot pin `pythonPlatform`, and (d) loses its severity settings the moment any `pyrightconfig.json` exists. 04 section 15.3 and 09 section 5.6 are superseded; the `typings/` "fallback tier" of 09 D-05 should be dropped.
6. **Two corrections to 07 itself** (P.3): dot-directories being "never type-checked" is false for a stub file that is open in the editor (5 errors appear in `machine.pyi`) unless the generated config also lists the stub directory in `ignore`; and 07 section 9.2's `.gitignore`-able `.mpy-workbench/` has a silent failure mode: if the extends target is missing, Pylance logs one `[error]` line and nothing else, the child's own keys still apply, and the student sees exactly complaint 2 again.
7. **The Python Environments extension does not interfere** [E]: with `python.useEnvironmentsExtension: true` the Python log says `Environment discovery is managed by the Python Environments extension` (the same line the critic found in the user's session), the workspace `.venv` is discovered and handed to Pylance (`Setting pythonPath ... .venv/bin/python`, its `site-packages` on the search path), and `Extra paths`, `Python platform` and every diagnostic are identical to the default run.
8. **OneDrive**: what could be executed is executed (paths with spaces, parentheses, `@`, non-ASCII, a symlinked workspace path, a missing/partial dot-directory, atomic rewrites); real OneDrive sync behaviour (conflict copies, File Provider placeholders, Windows file locks) is **not** testable here and is tagged [U]/[R] with mitigations built into the spec (P.4).

Confidence: P.0 items 1-4, 6, 7: high (>= 90%) for macOS + Pylance 2026.4.1 [E]. Item 5(a): high [E, real sync code]. Windows host behaviour: medium (the only Windows-specific effect, Pylance defaulting `pythonPlatform` to the host OS, is [E] on macOS by forcing `Windows`; the Windows default itself is [I]). OneDrive: medium-low (P.5).

### P.1 Method and its limits

* Scratch profile: `/tmp/mpyupg-pl` is a symlink to `$SP/pylance/runs` (needed because VS Code's IPC socket path must be < 103 characters and the scratchpad path is longer; the only file created outside the scratchpad, removed at the end of the session). Each scenario: copy a fixture project, apply overlays, start `Visual Studio Code.app/Contents/MacOS/Code --user-data-dir=... --extensions-dir=<scratch> --extensionDevelopmentPath=<probe> --disable-workspace-trust ...`, wait for `result.json`, copy the language-server, Python and Python Environments logs, kill that instance only (`pkill -f` on its own `--user-data-dir`).
* Fixtures: `student_A` = the previous gap's `F2_ignore` (real firmware outputs: `course-stubs/shield/*.py` verbatim from `$FW/python/shield`, generated `course-stubs/_shield.pyi`, the 129-file ESP32 1.29.0 stock stub set flattened by 07's installer, the user's real `test.py`/`boot.py`) plus `lib/mylib.py`, `check.py` and the generated file extended with `../lib`. `student_B` = the same content in the 04/09 layout (stock stubs and `_shield.pyi` in `typings/`, `.vscode/settings.json` with `extraPaths`, `ignore`, `typeCheckingMode: basic`, no config file). `prec` = a 7-line file importing modules that live in `pa/`, `pb/`, `pc/` and a stub-only module in `st/`, used for the precedence matrix. pyright 1.1.414 CLI on `student_A` gives the same 5 errors (baseline, so the Pylance run is comparable).
* Pylance's own readiness is not observable from the API, so the probe waits until the completion provider answers at the end of the first file, then until diagnostics and the language-server log have been quiet for 6 s. **Harness defect found and fixed**: my first version only waited a fixed time and one cold-start run (`p1`) returned 0 diagnostics; I replaced it and re-ran every scenario reported below (the four early calibration runs `p0a/b/d/e` used the old waiter and are not used for conclusions).
* Not covered: Windows (no run), real OneDrive, the Pyrefly diagnostics source, VS Code forks, multi-root workspaces, Pylance older/newer than 2026.4.1, the interaction with a student's own global `settings.json` (the scratch user settings contained only telemetry/UI keys and `logLevel: Trace`).

### P.2 Results

#### P.2.1 Settings versus config file (Pylance 2026.4.1) [E]

Fixture `prec`; settings S = `{extraPaths:["pb"], stubPath:"st", typeCheckingMode:"strict", diagnosticSeverityOverrides:{reportMissingImports:"none"}}`. "resolved" means Go to Definition lands in the module and no unresolved-import diagnostic.

| Run | Config on disk | mod_a (config path) | mod_b (settings extraPaths) | mod_c (pyproject path) | mod_s (settings stubPath) | strict applied | `reportMissingImports: none` applied |
|---|---|---|---|---|---|---|---|
| p1 | none | n/a | resolved | n/a | resolved | yes (unused-import, missing-param-type errors) | yes (no unresolved error for `nomod`) |
| p2 | `pyrightconfig.json {extraPaths:["pa"]}` | resolved | **not resolved** (list replaced) | n/a | **not resolved** | **no** (basic-like output) | **no** (`nomod` error) |
| p3 | `pyrightconfig.json {}` | n/a | **resolved** (log: `Extra paths: .../pb`) | n/a | not resolved | no | no |
| p4 | `pyrightconfig.json {typeCheckingMode:"basic"}` (course-template style) | n/a | **resolved** | n/a | not resolved | basic (config) | no |
| p5 | `pyproject.toml [tool.pyright] extraPaths=["pc"]` | n/a | not resolved | resolved | not resolved | no | no |
| p6 | `pyrightconfig.json {extraPaths:["pa"]}` **and** `pyproject [tool.pyright] extraPaths=["pc"]`, no settings | resolved | n/a | **not resolved** | n/a | n/a | n/a |
| p7 | as p2 plus undocumented `python.analysis.pythonPlatform:"Windows"` | resolved | not resolved | not resolved | not resolved | no | no; log `Python platform: Darwin` (the setting does not exist) |

Reading: (1) the moment `pyrightconfig.json` or `pyproject.toml [tool.pyright]` exists, `typeCheckingMode`, `stubPath` and `diagnosticSeverityOverrides` in `settings.json` are dead letters; (2) `python.analysis.extraPaths` is the single settings key that survives, and only as a default for a config that has no `extraPaths` (p3, p4), never merged with one (p2); (3) `pyrightconfig.json` beats `pyproject.toml` and the two are not merged (p6); (4) `pythonPlatform` cannot be set from settings at all (p7, and `b6` below). This is 07 section 3.2 S1-S7 verbatim, now on Pylance, plus the `typeCheckingMode` row.
`student_B` confirms it on the real pack: `b2` (add a template `pyrightconfig.json {typeCheckingMode:"basic"}`) keeps `extraPaths` from settings (shield, mylib resolve) but silently loses `reportMissingModuleSource: none` (5 yellow warnings in the 24-line `check.py`, 2 in `test.py`); `b4` (config with its own `extraPaths:["lib"]`) replaces the settings list, `shield` becomes unresolved in `check.py`, `test.py` and `probe.py`.

#### P.2.2 `extends` chain and the generated file [E]

| Run | What was done | Observation |
|---|---|---|
| a1 | layout A: child `{extends, typeCheckingMode:"basic", reportMissingModuleSource:"none"}` + generated `{pythonPlatform:"Linux", ignore:["../course-stubs"], stubPath:"stubs/active", extraPaths:["../lib","../course-stubs"]}` | log: `Loading configuration file at .../pyrightconfig.json` then `.../.mpy-workbench/pyright.generated.json`; `Extra paths: lib, course-stubs`; `Python platform: Linux`; `Search paths: typeshed stdlib, <ws>, lib, course-stubs, .mpy-workbench/stubs/active, typeshed stubs, bundled stubs, interpreter paths`; results as in P.0 item 2. Relative paths inside the base resolve against the **base file's directory** |
| a9 | child with `//` and `/* */` comments and a trailing comma | loaded and applied (the generated file's `// GENERATED` header is also accepted, so JSONC is fine for both) |
| a10 | `"extends": "./.mpy-workbench/..."` | same as a1 |
| a3 | extends target deleted | `[error] Config file ".../pyright.generated.json" could not be read.`; child keys still apply (`typeCheckingMode: basic`); `Extra paths: (none)`, `Python platform: Darwin`, search paths show only `<ws>` and `<ws>/typings`. `check.py`: 11 errors, `test.py`: **6 errors identical to the previous gap's F.2 baseline** (`import shield` unresolved, five `time.*` attribute errors). The failure is visible only in the output channel |
| a4 | start with a generated file lacking `../lib`; rewrite **only the base** file | `14:42:07.978` write; `14:42:08.320` `Received fs event 'change' for config file`; `14:42:08.420` both config files reloaded; `mylib` goes from unresolved to `lib/mylib.py:1` with no restart. Rewriting the child with identical bytes triggers another reload; `python.analysis.restartLanguageServer` starts a new server process but changes nothing |
| a12 | write `pyright.generated.json.tmp`, rename over the target | `fs event 'add' for config file`, reload 0.1 s later, `mylib` resolved. Atomic temp+rename regeneration is safe |
| a5 | while running: add `stubs/active/newmod.pyi`, add `course-stubs/coursemod.py`, change `course-stubs/_shield.pyi` | all three picked up (`SourceFile: Received fs event 'add'/'change'`); `import newmod`/`coursemod` resolve, the arity message follows the edited stub |
| a15 | `extraPaths` lists `../lib` but `lib/` does not exist at startup; create `lib/mylib.py` later | unresolved before, resolved after, no restart. The generator may always emit `../lib` |
| a6 | child sets `extraPaths:["course-stubs"]`; base lists `["../lib","../course-stubs"]` and `reportMissingModuleSource:"none"`; child `typeCheckingMode:"basic"` | `mylib` unresolved (child list **replaces** the base list); `import yaml` (typeshed stub-only) is a **warning** again (child `typeCheckingMode` re-derives the rule set and discards the base's rule override). 07 section 3.3, now on Pylance |
| a6b | child without `typeCheckingMode`, base carries the rule override | no `reportMissingModuleSource` warning (the base override survives when the child does not set a mode) |
| a14 | same layout under the new directory name from 09 D-06 (`.mpybench`) | identical results; the dot-directory name is irrelevant (the auto-exclude glob is `**/.*`) |

#### P.2.3 `stubPath` into a dot-directory [E]

* a1/a14: stock stubs under `.mpy-workbench/stubs/active` (or `.mpybench/...`) take priority over typeshed's stdlib for `time`, `os`, `sys`, `json`, `asyncio`: `time.sleep_ms` -> `.../stubs/active/time.pyi:284`, `os.ilistdir` -> `os/__init__.pyi:1313`, `os.uname` -> `os/__init__.pyi:575`. Go to Definition therefore lands in the **MicroPython stub**, not in a CPython file (the micropython-stubs docs warn about the CPython landing for the `typeshedPaths` route; the `stubPath` route does not have that problem).
* Pylance's log prints `Auto-excluding **/.*` and still resolves imports through the dot-directory; excluded means "not enumerated as a source file" (`Found 10 source files` in layout A versus `Found 138` in the visible-`typings/` layout under `diagnosticMode: workspace`).
* **Opening a stub file reports its diagnostics even in a dot-directory** (a2): `machine.pyi` shows 5 errors (`"LSB"`/`"MSB"` cannot be redeclared because parent class `SPI` declares it as Final; `"adcchannel" is not defined` x3) and `time.pyi` 4 hints. With `"ignore": ["../course-stubs", "stubs"]` in the generated file (a2b) all of these are 0, and `course-stubs/shield/motor.py` also shows 0 (as the previous gap's F.6 rule 2 predicted). A student who Ctrl-clicks `machine.Pin` would otherwise get 5 red entries in the Problems panel.
* Setting `stubPath` replaces Pylance's default `typings`: the a1/a14 search-path lists contain no `<ws>/typings`. A student's pre-existing `typings/` is therefore silently dropped by the generated config; list `../typings` in `extraPaths` when the directory exists [I that extraPaths placement is adequate; the dropping is [E]].
* `b6` (settings-only form of layout A: `python.analysis.stubPath: ".mpy-workbench/stubs/active"`, `extraPaths`, `ignore`, no config file) resolves and reports exactly like layout A, including the relative-to-workspace-root rule for `stubPath` in settings; its only difference is `Python platform: Darwin`.

#### P.2.4 `pythonPlatform` [E]

* a7: generated file with `"pythonPlatform":"Windows"` -> log `Python platform: Windows` and `"uname" is not a known attribute of module "os"` on `os.uname()`. a7b: key omitted on this macOS host -> `Python platform: Darwin`, no error. So the default follows the **host OS**, which is why a class with macOS and Windows laptops would see different diagnostics; on a Windows laptop the default is Windows [I, same mechanism].
* a7c/a7d: a probe with 19 `os.*` expressions (18 distinct names), 9 `sys.*` names and 10 common imports. Windows platform: **exactly one** false positive, `os.uname` (flagged at both of its occurrences); Linux: none. So the leak is narrow but it is the single most common call in MicroPython tutorials (`os.uname()` prints the board). The micropython-stubs `os/__init__.pyi` has 69 `sys.platform` conditionals, `sys` 8, `ssl` 3, `asyncio` 6.
* `pythonPlatform` is accepted only from a config file (a7/a7b/p7/b6). The same holds for `ignore` in config versus `python.analysis.ignore` in settings, but the latter exists, so only the platform forces a config file.

#### P.2.5 Python Environments extension and the user's `.venv` [E]

Fixture `student_A` plus `python3 -m venv .venv` and `pip install mpremote==1.29.0` from the local wheel cache, in the workspace (the user's situation).

| Run | Setting | Result |
|---|---|---|
| v1 | default (`python.useEnvironmentsExtension` false) | `Setting pythonPath ... ws/.venv/bin/python`; `.venv/lib/python3.15/site-packages` on the search path; IntelliSense results identical to a1 |
| v2 | `python.useEnvironmentsExtension: true` | Python log: `Environment discovery is managed by the Python Environments extension (ms-python.vscode-python-envs)`; PET log `Discovered env: .../ws/.venv/bin/python`; Pylance gets the same `.venv`; `Extra paths`, `Python platform: Linux`, diagnostics and queries identical to v1 |
| v3 | v2 plus workspace `python.defaultInterpreterPath: ${workspaceFolder}/.venv/bin/python` | same; the language server was restarted three times in the first second while settings landed, then identical results |

Consequence: the IntelliSense layer does not depend on which of the two environment-discovery paths is active, and Pylance does not need the interpreter to resolve `machine`, `shield` or `time.sleep_ms` (those come from `stubPath`/`extraPaths`). The only coupling is that `mpremote` installed into `.venv` adds nothing to MicroPython diagnostics. 01 section 5's resolver concerns (which Python the extension runs) are unrelated to Pylance configuration.

#### P.2.6 Visible `typings/` (layout B of 04/09) versus the dot-directory [E]

| Run | Layout | Result |
|---|---|---|
| b5 | `typings/` only, no settings, no config (09 section 5.6: "no settings change is needed") | stock imports resolve and `time.sleep_ms`/`os.ilistdir` are fine, **but** `check.py` has 9 warnings (5x `reportMissingModuleSource` on `time`, `sys`, `machine`, `neopixel`, `_shield`; `shield`, `mylib`, `notamodule` unresolved), `test.py` 3, `Python platform: Darwin`. Complaint 2 for `shield` is not solved without `extraPaths` |
| b1 | `typings/` + `.vscode/settings.json` (04/09 form) | works: same 5 intended errors, same definitions (`typings/time.pyi:284`), `shield.` completion identical; opening `typings/machine.pyi` shows the same 5 errors |
| b3 | b1 + `python.analysis.diagnosticMode: "workspace"` | `Found 138 source files`; **62 stub files carry diagnostics, 59 errors/warnings, 332 including hints** (`ssl.pyi` 18, `io.pyi` 6, `asyncio/events.pyi` 5, ...). Layout A under the same mode (a8): `Found 10 source files`, only the 2 user files have diagnostics |
| b2, b4 | add a config file | see P.2.1: severity override lost / extraPaths replaced |
| b6 | settings-only dot-directory form | works, cannot pin the platform |

#### P.2.7 Does the old sync upload `typings/`? [E, real code]

I ran the **installed 0.3.2 `dist/sync.js`** (user's build) and the HEAD build's `sync.js` (`createIgnoreMatcher` + `buildManifest`, the code that produces the upload set, `sync.ts:105-123`, `sync.ts:15-39`) on copies of the two layouts, with the user's real `~/src/mpy_test/.mpy-workbench/.mpyignore` (59 lines, copied, not modified) in place:

| Workspace | Files in the upload set |
|---|---|
| layout A (`.mpy-workbench/` dot-directory, `course-stubs/`, `pyrightconfig.json`, `lib/`) | 11: `boot.py check.py probe.py test.py lib/mylib.py` **plus `pyrightconfig.json` and the 5 `course-stubs/` files**; the dot-directory is ignored (default list `sync.ts:83` and the user's file both contain `.mpy-workbench/`) |
| layout B (`typings/` with the stock stubs + `_shield.pyi`) | **139: 130 files from `typings/` (787,235 bytes)**, 4 `course-stubs` files, the 5 user files. `.vscode/` is ignored. Result identical with and without the `.mpyignore` file (the defaults do not contain `typings/`) |
| both, after appending `typings/ course-stubs/ pyrightconfig.json .mpybench/ *.pyi` | 5 files (the user's) |

So 04 section 10's statement is **confirmed by execution**, in both builds; `typings/` would put 130 files (about 0.77 MB of the board's flash filesystem, plus the upload time over serial) on every student's board, and `pyrightconfig.json` and `course-stubs/` are uploaded today too. The existing `.mpyignore` file cannot be the fix for existing workspaces: it is written once, so the new entries must be **hard-coded defaults** (`defaultIgnorePatterns()` is merged with the file at every call, `sync.ts:105-123`). Side finding [E]: the same real `.mpyignore` has `*.py[cod]` and the matcher's `globToRegExp` escapes `[`/`]`, so `x.pyc` and `lib/x.pyc` are **not** ignored; the new matcher must be a tested gitignore implementation, not a port of this one. Also `pyrightconfig.json` without a leading `/` matches in every directory.

#### P.2.8 OneDrive-like paths, partial state, and workspace root [E unless tagged]

* o1: workspace path `.../CloudStorage/OneDrive-ExampleUniversity(student@example.edu)/ME 241 (Fall 2026)/Lab é1` (the shape of the instructor's macOS File Provider path from 09 N-10, with a fictional name): identical results to a1; `Loading configuration file` and `Extra paths` print the full path intact.
* o2: the same folder opened through a symlink (the `~/OneDrive-X` -> `~/Library/CloudStorage/OneDrive-X` convention): identical results; definitions and diagnostics are reported under the link path, no real-path mismatch.
* a3/a4/a12/a15 are the OneDrive-relevant partial-state cases: the dot-directory missing on a second machine (-> complaint 2 symptoms, visible only in the log), arriving later (-> reload in 0.1-0.3 s, no restart), arriving as a temp-file rename, and `lib/` arriving after the config.
* w2: the **VS Code workspace folder is the parent** of the project (instructor opens the whole course folder; project in `lab1/`): the config in `lab1/` is not found; log `Extra paths: (none)`, all of `shield`, `_shield`, `mylib`, `machine`, `neopixel` unresolved. Pylance does not look for config files in subfolders of the workspace folder (searching *up* from a child workspace was not tested, P.5). The extension must compare the workspace folder with the mirror root and warn.
* [R] Microsoft's OneDrive restrictions page (https://support.microsoft.com/en-us/office/restrictions-and-limitations-in-onedrive-and-sharepoint-64883a5d-228e-48f5-b3d2-eb39e07630fa): no rule against names starting with a dot; reserved names `.lock`, `CON`, `PRN`, `AUX`, `NUL`, `COM0-9`, `LPT0-9`, `_vti_`, `desktop.ini`, anything starting `~$`; `.TMP` files and `.ds_store` do not sync; **symbolic links and junction points are not supported**; invalid characters `" * : < > ? / \ |`, leading/trailing spaces. Consequences: a hidden `.mpy-workbench`/`.mpybench` directory is an ordinary synced folder; a `.tmp` temp name is not synced (good for atomic writes); a symlink or junction based stub directory (MicroPico's approach) would not roam, which confirms 07's "no symlinks" rule.
* [R, secondhand] Files On-Demand on macOS: files hydrate when opened, folders can be pinned "always keep on this device", and the OneDrive folder lives under `~/Library/CloudStorage` (techcommunity thread https://techcommunity.microsoft.com/discussions/onedriveforbusiness/files-on-demand-for-macos-qa/3101140/replies/3106456; https://cnsit.colostate.edu/kb/mac-onedrive-client-files-on-demand/). Whether Pylance's first read of 129 dehydrated `.pyi` files stalls is **[U]**; the extension writes those files itself, so on the machine that generated them they are local.
* **[U] not testable here**: OneDrive conflict copies when two computers regenerate the same file, Windows `EBUSY`/`EPERM` on the temp-file rename while the sync client holds the file, Defender latency on 129 new files, whether the sync client dehydrates `.mpy-workbench/stubs`.

### P.3 Where this evidence contradicts or corrects earlier notes

1. **07 section 3.2 caveat and 09 N-5/S-04 ("Pylance itself has still never been executed")**: closed. Result: 07's table holds on Pylance 2026.4.1; the new row is that `typeCheckingMode` in settings is also ignored when a config exists.
2. **07 section 3.1, last bullet ("Dot-directories are auto-excluded ... never type-checked itself")**: true for enumeration, **false for an open file**. `machine.pyi` shows 5 errors when opened from a dot-directory (a2). Fix: `ignore` for the stock-stub directory in the generated file (a2b). The previous gap's F.6 rule 2 added `ignore` only for `course-stubs`.
3. **07 section 9.5 step 6 and 12.3** ("prompt to reload/restart the language server only if it did not pick the change up"): the extends target and temp+rename writes are watched (a4, a12); never call `python.analysis.restartLanguageServer`. 12.3's generated file lacks `ignore` and always-present `../lib` handling; use the P.4 form.
4. **07 section 9.2 / 9.7** (`.mpy-workbench/` can be git-ignored and regenerated "silently"): correct, but the degraded state in between is silent in Pylance (a3). The extension must regenerate before or immediately after Pylance starts and must not rely on Pylance to complain; since the file watcher picks up an added file in 0.1 s (a12), ordering does not matter for correctness, only for a brief flash of red.
5. **09 D-05** ("`typings/` stays as a fallback tier ... switched on only if S-04 shows real Pylance does not honour the generated config") and **04 section 15.3 / 09 section 5.6** (`typings/` + settings.json merge, "no settings change is needed"): S-04 is done and the generated config **is** honoured; the fallback tier should not be built. The zero-configuration claim is wrong in two ways: b5 (9 warnings per 24 lines, `shield` unresolved) and P.2.1 (any later config file disables the settings route).
6. **09 N-5 phrase "07 section 3.2 observed per-key replacement rather than total replacement"**: precisely, per key only for `extraPaths`; for `stubPath`, `typeCheckingMode`, severity overrides and `typeshedPaths` the settings value is discarded as a whole once a config file exists.
7. **10-completeness-critic section 5 item 3 / 09 F2 item 8 ("half right")**: for the old extension's defaults the critic's reading is fully right (P.2.7, executed). The half that 09 conceded (04/07 already list `typings/` for the new ignore list) concerns the *new* design, not the old behaviour.
8. **07 section 9.2 template comment "Do NOT add extraPaths here"** is verified as necessary (a6, p2, b4) and should also appear next to `ignore`/`stubPath` (child keys replace base keys).
9. **No contradiction found** with the previous gap's F.5-F.8 (course pack, `ignore`, sync-ignore of `course-stubs/`); P.2.7 adds the execution proof for F.6 rule 3 (the pack is uploaded today).

### P.4 The IntelliSense file-layout contract (single spec; supersedes the layouts of 04 section 15.3 and 09 section 5.6)

Dot-directory name: placeholder `.mpybench/` (09 D-06); Pylance is indifferent (a14). Everything below is relative to the **VS Code workspace folder, which must be the board-mirror root** (w2).

| Path | Owner | In git / template | Uploaded to board | Written by the extension |
|---|---|---|---|---|
| `pyrightconfig.json` | user (instructor template or student) | yes | **no** (hard-coded sync ignore) | created once, with consent, if absent and no `[tool.pyright]`; **never modified afterwards** |
| `.mpybench/pyright.generated.json` | extension | no (`.gitignore` line added with consent) | no | rewritten only if bytes differ; via `pyright.generated.json.tmp` + rename |
| `.mpybench/stubs/active/**` | extension | no | no | unpacked from the VSIX bundle (stock ESP32 stubs + the 10 stdlib overrides of 12.4), only when the pick or bundle version changed |
| `.mpybench/stamp.json` (or inside the report) | extension | no | no | `{bundle version, stub package@version, pack stamp}`; drives staleness |
| `course-stubs/**` (`shield/*.py` verbatim, `_shield.pyi`) | instructor | **yes** (template) | **no** (hard-coded sync ignore) | only by the instructor-side export command (previous gap F.6) |
| `lib/**`, `main.py`, `boot.py`, ... | student | yes | yes (mirror) | sync engine |
| `typings/` | user | optional | **no** (hard-coded sync ignore) | **never written or read by the extension**; listed in `extraPaths` only if it already exists |
| `.vscode/settings.json` | user/template | yes | no (ignored) | **no `python.analysis.*` or `python.languageServer` keys, ever** |
| `pyproject.toml [tool.pyright]` | user | yes | no | never; if present the extension reports instead of creating `pyrightconfig.json` (a root `pyrightconfig.json` would win silently, p6) |

**Content** (verified as a1/a2b/a14):

```jsonc
// pyrightconfig.json  -- USER-OWNED. Created once; never rewritten by MPY Workbench.
{
  "extends": ".mpybench/pyright.generated.json",
  "typeCheckingMode": "basic",
  "reportMissingModuleSource": "none"
  // Do NOT add "extraPaths", "stubPath", "ignore" or "pythonPlatform" here: a child key REPLACES the generated one.
  // Rule severities belong here, not in the generated file: a child "typeCheckingMode" discards base rule overrides.
}
```
```jsonc
// .mpybench/pyright.generated.json -- GENERATED, rewritten when inputs change. Paths are relative to THIS file, forward slashes only.
{
  "pythonPlatform": "Linux",
  "ignore": ["../course-stubs", "stubs"],
  "stubPath": "stubs/active",
  "extraPaths": ["../lib", "../course-stubs"]   // + "../typings" if typings/ exists; + user entries from mpyWorkbench.intellisense.extraPaths
}
```

**Rules** (each tied to evidence):
1. *One mechanism.* Config file only. Do not mirror into `.vscode/settings.json`: once the config exists those keys are ignored (P.2.1), and if the config also has `extraPaths` they are replaced. The settings route is a legitimate manual fallback only for a project without any config file (b6), and it cannot pin `pythonPlatform`.
2. *Always pin `pythonPlatform: "Linux"`.* It is not a Pylance setting (p7, b6); the host default differs per OS (a7b); a Windows analysis flags `os.uname()` (a7c).
3. *Only relative, forward-slash paths in the generated file.* The file then roams through OneDrive/git/zip between macOS and Windows machines. Absolute paths (firmware repo on another drive) belong to the instructor-side tool, never to the student layout.
4. *`ignore` both the course pack and the stock-stub directory* (a2, a2b), or Problems fills with stub-quality errors the moment a stub is opened or `diagnosticMode` is `workspace` (b3).
5. *Always emit `../lib` even if `lib/` does not exist yet* (a15); emit `../course-stubs` only if it exists at generation time and refresh when it appears (a5).
6. *Write only when bytes change; temp file + rename; temp suffix `.tmp`.* Pylance reloads on any change event (a4: identical rewrite of the child reloads), OneDrive does not sync `.tmp` names, and 129 unchanged files should not be rewritten at every activation.
7. *Never restart the language server and never show a "reload" prompt* for stub or config changes (a4, a5, a12).
8. *Hard-coded sync-ignore defaults* (not just the written `.mpyignore`, P.2.7): the dot-directory, `course-stubs/`, `typings/`, `/pyrightconfig.json`, `*.pyi`, `.venv/`, `venv/`, `env/`, `.vscode/`, `.git/`, plus the existing list. Root-anchor `/pyrightconfig.json`.
9. *Health check on activation (files only, no Pylance API needed)*: (a) workspace folder == mirror root, else warn (w2); (b) `pyrightconfig.json` exists and `extends` resolves, else offer create/regenerate; (c) the generated file exists and its stamp matches, else regenerate silently (a3: otherwise complaint 2 returns invisibly); (d) the user's config sets none of `extraPaths`/`stubPath`/`ignore`/`pythonPlatform` without `extends` handling, else show the conflict panel of 07 section 9.6; (e) `pyproject.toml [tool.pyright]` or a `pyrightconfig.json` that does not extend ours -> report, do not edit.
10. *Course-template shipping list*: `pyrightconfig.json`, `course-stubs/`, `.gitignore` containing the dot-directory, workspace settings with `mpyWorkbench.intellisense.autoConfigure: always` (07 section 9.4). The dot-directory is regenerated on first open (about 0.3 s per 07 section 9.7).
11. *Pylance is optional in the contract.* basedpyright reads the same files [E in 07 section 4]; Pyrefly diagnostics source and other forks are [U].

### P.5 Confidence, limits, how to verify

| Claim | Confidence | Basis | Refute / verify by |
|---|---|---|---|
| Layout A resolves and diagnoses correctly in Pylance 2026.4.1 on macOS | high (>= 95%) | [E] real extension host, 10+ scenarios, log + API results agree | open `$SP/real/F2_ignore`-style pack in VS Code, "Python: Show Language Server Output" at `logLevel: Trace` |
| Settings-versus-config table P.2.1 | high | [E] 7 scenarios + 3 on the real pack; matches pyright 1.1.414 CLI/langserver results of 07 | rerun `scenarios/prec.mjs` |
| Extends target is watched, no restart needed | high | [E] log timestamps a4, a12 | rewrite the file while VS Code is open and watch the log |
| Dot-directory vs `typings/` verdict | high | [E] b1/b3/b5/a8, [E] real sync code | n/a |
| Windows host defaults `pythonPlatform` to Windows and shows the `os.uname` false positive | medium | [E] the mechanism (a7), [I] the Windows default | open the pack on a Windows machine without `pythonPlatform` |
| Layout is safe in OneDrive on macOS and Windows | medium-low | [E] path shapes, partial-state and atomic-write behaviour; [R] OneDrive rules; [U] sync client behaviour | pilot with 2 student machines sharing one OneDrive folder (conflict copies, dehydration, `EBUSY` on rename); keep rule 6 and the retry-with-backoff on rename |
| Behaviour with Pyrefly as diagnostics source, in Cursor/VSCodium, in Pylance versions other than 2026.4.1 | unknown | not run | pin the Pylance version in the instructor's setup notes; rerun the harness on the new version |
| Config discovery from a parent directory when the workspace is a *child* of the folder holding the config | unknown | not run (only the parent-workspace case w2) | add a scenario |

### P.6 Reproduction record and harness sources

All under `$SP/pylance/` (session-temporary; `$SP` = the session scratchpad): `exts/` (cloned Microsoft extensions), `probe-ext/` (harness), `tools/run.mjs`, `tools/brief.py`, `scenarios/*.mjs`, `fixtures/{student_A,student_B,prec}`, `runs/<scenario>/{ws,out/result.json,logs/*.log}`, `ign/` (sync-ignore execution). Run one scenario: `node tools/run.mjs scenarios/layout.mjs#a4`, summarize: `python3 tools/brief.py runs/a4`. Scenario list: layout A `a1 a2 a2b a3 a4 a5 a6 a6b a7 a7b a7c a7d a8 a9 a10 a12 a14 a15`; layout B/settings `b1 b2 b3 b4 b5 b6`; precedence `p1-p7`; environment `v1-v3`; paths `o1 o2 w2`. Upload test: `node ign/upload_set.js installed|head <workspace>` with `ign/sync_installed.js` = the installed `dist/sync.js`, `ign/sync_head.js` = the HEAD build.

`probe-ext/extension.js` (drives the editor and records state; loaded with `--extensionDevelopmentPath`; its `config.json` is written per run by `run.mjs`):

````js
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cfg, out, wsRoot;
const log = (m) => { try { fs.appendFileSync(path.join(out, 'probe.log'), new Date().toISOString() + ' ' + m + '\n'); } catch {} };
function normDiag(d) {
  const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
  return { sev: ['Error', 'Warning', 'Info', 'Hint'][d.severity], code: code ?? null, msg: d.message, src: d.source ?? null, line: d.range.start.line + 1, col: d.range.start.character + 1 };
}
function diagsFor(uri) { return vscode.languages.getDiagnostics(uri).map(normDiag); }
function uriOf(rel) { return vscode.Uri.file(path.isAbsolute(rel) ? rel : path.join(wsRoot, rel)); }
async function openDoc(rel) {
  const doc = await vscode.workspace.openTextDocument(uriOf(rel));
  await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
  return doc;
}
function posOf(doc, find, occurrence = 1, offset = 0) {
  const text = doc.getText(); let idx = -1;
  for (let i = 0; i < occurrence; i++) idx = text.indexOf(find, idx + 1);
  return idx < 0 ? null : doc.positionAt(idx + offset);
}
const locStr = (l) => { const uri = l.targetUri ?? l.uri; const r = l.targetRange ?? l.range; return uri.fsPath.replace(wsRoot, '<ws>') + ':' + (r.start.line + 1); };
async function query(q) {
  const doc = await openDoc(q.file);
  const pos = posOf(doc, q.find, q.occurrence ?? 1, q.offset ?? 0);
  const res = { ...q };
  if (!pos) { res.error = 'text not found'; return res; }
  try {
    if (q.kind === 'def') res.result = ((await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, pos)) || []).map(locStr);
    else if (q.kind === 'hover') res.result = ((await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, pos)) || []).map((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n').slice(0, 400));
    else if (q.kind === 'complete') {
      const r = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, pos); const items = (r && r.items) || [];
      res.count = items.length; res.result = items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label)).slice(0, q.limit ?? 400);
    }
  } catch (e) { res.error = String(e); }
  return res;
}
function inspectSettings() {
  const o = {};
  for (const k of ['extraPaths', 'stubPath', 'typeshedPaths', 'typeCheckingMode', 'diagnosticSeverityOverrides', 'diagnosticMode', 'logLevel', 'include', 'exclude', 'useLibraryCodeForTypes', 'autoSearchPaths']) {
    const i = vscode.workspace.getConfiguration('python.analysis').inspect(k);
    if (i) o[k] = { default: i.defaultValue, global: i.globalValue, ws: i.workspaceValue, wsFolder: i.workspaceFolderValue };
  }
  o['python.useEnvironmentsExtension'] = vscode.workspace.getConfiguration('python').get('useEnvironmentsExtension');
  return o;
}
let lsLogPath = null;   // sibling of this extension's log dir: .../exthost/ms-python.python/Python Language Server.log
function lsLogSize() { try { return lsLogPath ? fs.statSync(lsLogPath).size : -1; } catch { return -1; } }
async function settle(files, { minMs = 15000, quietMs = 6000, maxMs = 150000 } = {}) {
  const t0 = Date.now(); let ready = false;
  try {   // server is up when completion at the end of the first file returns > 20 items
    const doc = await openDoc(files[0]); const pos = doc.positionAt(doc.getText().length);
    while (Date.now() - t0 < maxMs) {
      const r = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, pos);
      if (r && r.items && r.items.length > 20) { ready = true; break; }
      await sleep(1500);
    }
  } catch (e) { log('settle ready err ' + e); }
  let last = '', lastChange = Date.now(), lastSize = lsLogSize(), lastGrow = Date.now();
  for (;;) {   // then diagnostics AND the server log must both be quiet
    const snap = JSON.stringify(files.map((f) => diagsFor(uriOf(f))));
    if (snap !== last) { last = snap; lastChange = Date.now(); }
    const sz = lsLogSize(); if (sz !== lastSize) { lastSize = sz; lastGrow = Date.now(); }
    const el = Date.now() - t0;
    if (el > maxMs) return false;
    if (ready && el > minMs && Date.now() - lastChange > quietMs && Date.now() - lastGrow > quietMs) return true;
    await sleep(1000);
  }
}
async function runSteps() {
  const snaps = {};
  const writeResult = (final) => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ final, env: inspectSettings(), snaps, ext: Object.fromEntries(['ms-python.python', 'ms-python.vscode-pylance', 'ms-python.vscode-python-envs'].map((id) => [id, vscode.extensions.getExtension(id)?.packageJSON.version ?? null])) }, null, 1));
  for (const step of cfg.steps) {
    log('step ' + JSON.stringify(step).slice(0, 200));
    try {
      switch (step.op) {
        case 'open': for (const f of step.files) await openDoc(f); break;
        case 'wait': await sleep(step.ms); break;
        case 'settle': await settle(step.files, step); break;
        case 'write': { const p = uriOf(step.path).fsPath; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, step.content); break; }
        case 'rename': fs.renameSync(uriOf(step.from).fsPath, uriOf(step.to).fsPath); break;
        case 'rm': fs.rmSync(uriOf(step.path).fsPath, { recursive: true, force: true }); break;
        case 'command': await vscode.commands.executeCommand(step.id, ...(step.args || [])); break;
        case 'snapshot': {
          const s = { diags: {}, queries: [] };
          for (const f of step.files || []) s.diags[f] = diagsFor(uriOf(f));
          for (const q of step.queries || []) s.queries.push(await query(q));
          if (step.all) s.all = vscode.languages.getDiagnostics().map(([u, ds]) => [u.fsPath.replace(wsRoot, '<ws>'), ds.filter((d) => d.severity < 2).length, ds.length]).filter((x) => x[2] > 0);
          s.settings = inspectSettings(); snaps[step.name] = s; writeResult(false); break;
        }
      }
    } catch (e) { log('step error ' + e); snaps['error@' + step.op] = String(e); }
  }
  writeResult(true); fs.writeFileSync(path.join(out, 'done'), 'ok');
}
exports.activate = async function activate(ctx) {
  cfg = JSON.parse(fs.readFileSync(path.join(ctx.extensionPath, 'config.json'), 'utf8'));
  try { lsLogPath = path.join(path.dirname(ctx.logUri.fsPath), 'ms-python.python', 'Python Language Server.log'); } catch {}
  out = cfg.out; wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? cfg.ws;
  for (const id of ['ms-python.python', 'ms-python.vscode-pylance']) { const e = vscode.extensions.getExtension(id); if (e && !e.isActive) { try { await e.activate(); } catch (x) { log('activate fail ' + id + ' ' + x); } } }
  try { await runSteps(); } catch (e) { fs.writeFileSync(path.join(out, 'done'), 'error ' + e); }
  setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 1500);
};
````

`probe-ext/package.json`: `{"name":"probe","publisher":"local","version":"0.0.1","engines":{"vscode":"^1.100.0"},"main":"./extension.js","activationEvents":["onStartupFinished"]}`.
`exts/extensions.json`: the user's `~/.vscode/extensions/extensions.json` entries for `ms-python.vscode-pylance`, `ms-python.python`, `ms-python.vscode-python-envs`, `ms-python.debugpy`, with `location.path` rewritten to the scratch directory (the folders were cloned with `cp -cR`).

`tools/run.mjs` (orchestrator; scenario objects are `{name, fixture, files:{rel:content|null}, prepare:[shell], userSettings, steps:[...], symlink, wsDirName, nest}`):

````js
import fs from 'node:fs'; import path from 'node:path';
import { spawnSync, execSync, spawn } from 'node:child_process'; import { pathToFileURL } from 'node:url';
const P = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [scnPath, scnName] = process.argv[2].split('#');
const mod = await import(pathToFileURL(path.resolve(scnPath)).href); const scn = scnName ? mod[scnName] : mod.default;
const run = path.join(P, 'runs', scn.name); fs.rmSync(run, { recursive: true, force: true }); fs.mkdirSync(run, { recursive: true });
const wsDir = path.join(run, scn.wsDirName ?? 'ws'); const out = path.join(run, 'out'); fs.mkdirSync(out);
const udd = path.join(run, 'user-data'); fs.mkdirSync(path.join(udd, 'User'), { recursive: true });
if (scn.fixture) { fs.mkdirSync(path.dirname(wsDir), { recursive: true });
  if (scn.nest) { fs.mkdirSync(wsDir, { recursive: true }); execSync(`cp -R "${path.join(P, 'fixtures', scn.fixture)}" "${path.join(wsDir, scn.nest)}"`); }
  else execSync(`cp -R "${path.join(P, 'fixtures', scn.fixture)}" "${wsDir}"`); } else fs.mkdirSync(wsDir, { recursive: true });
for (const [rel, content] of Object.entries(scn.files ?? {})) { const p = path.join(wsDir, rel);
  if (content === null) { fs.rmSync(p, { recursive: true, force: true }); continue; }
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2)); }
for (const cmd of scn.prepare ?? []) spawnSync('/bin/bash', ['-c', cmd], { cwd: wsDir, encoding: 'utf8' });
let openPath = wsDir; if (scn.symlink) { openPath = path.join(run, 'link-' + path.basename(wsDir)); fs.symlinkSync(wsDir, openPath); }
fs.writeFileSync(path.join(udd, 'User', 'settings.json'), JSON.stringify({ 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none',
  'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'window.restoreWindows': 'none', 'python.analysis.logLevel': 'Trace',
  'security.workspace.trust.enabled': false, 'workbench.enableExperiments': false, 'chat.disableAIFeatures': true, ...(scn.userSettings ?? {}) }, null, 2));
const probe = path.join(run, 'probe-ext'); execSync(`cp -R "${path.join(P, 'probe-ext')}" "${probe}"`);
fs.writeFileSync(path.join(probe, 'config.json'), JSON.stringify({ out, ws: openPath, steps: scn.steps }, null, 1));
const uddShort = path.join('/tmp/mpyupg-pl', scn.name, 'user-data');   // IPC socket path must be < 103 chars; /tmp/mpyupg-pl -> $SP/pylance/runs
const child = spawn('/Applications/Visual Studio Code.app/Contents/MacOS/Code', [`--user-data-dir=${uddShort}`, `--extensions-dir=${path.join(P, 'exts')}`,
  `--extensionDevelopmentPath=${probe}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--new-window', openPath],
  { detached: true, stdio: ['ignore', fs.openSync(path.join(run, 'launch.out'), 'w'), 'inherit'] }); child.unref();
const t0 = Date.now(); let status = 'timeout';
while (Date.now() - t0 < (scn.timeoutS ?? 240) * 1000) { if (fs.existsSync(path.join(out, 'done'))) { status = fs.readFileSync(path.join(out, 'done'), 'utf8'); break; } await new Promise((r) => setTimeout(r, 1000)); }
await new Promise((r) => setTimeout(r, 4000)); spawnSync('pkill', ['-f', `--user-data-dir=${uddShort}`]); await new Promise((r) => setTimeout(r, 1500)); spawnSync('pkill', ['-9', '-f', `--user-data-dir=${uddShort}`]);
const logs = execSync(`find "${udd}/logs" -name "*.log" 2>/dev/null || true`, { encoding: 'utf8' }).split('\n').filter(Boolean);
fs.mkdirSync(path.join(run, 'logs'), { recursive: true });
logs.filter((f) => /Python Language Server\.log$/.test(f)).forEach((f, i) => fs.copyFileSync(f, path.join(run, 'logs', `pylance-${i}.log`)));
for (const f of logs.filter((f) => /Python( Environments)?\.log$/.test(f))) fs.copyFileSync(f, path.join(run, 'logs', path.basename(path.dirname(f)) + '-' + path.basename(f)));
console.log(JSON.stringify({ scenario: scn.name, status, seconds: Math.round((Date.now() - t0) / 1000) }));
````

Scenario definitions that carry the decisive configuration (the remaining ones differ only in the overlay text listed in P.2.2):

````js
// common.mjs
export const FILES = ['check.py', 'test.py', 'probe.py'];
export const QUERIES = [ // def: shield, _shield, time.sleep_ms, os.ilistdir, os.uname, mylib, machine.Pin; hover machine.Pin; complete after "shield."
  { file: 'check.py', kind: 'def', find: 'import shield', offset: 8 }, { file: 'check.py', kind: 'def', find: 'import _shield', offset: 9 },
  { file: 'check.py', kind: 'def', find: 'time.sleep_ms', offset: 6 }, { file: 'check.py', kind: 'def', find: 'os.ilistdir', offset: 4 },
  { file: 'check.py', kind: 'def', find: 'os.uname', offset: 4 }, { file: 'check.py', kind: 'def', find: 'import mylib', offset: 8 },
  { file: 'check.py', kind: 'def', find: 'machine.Pin(', offset: 8 }, { file: 'check.py', kind: 'hover', find: 'machine.Pin(', offset: 8 },
  { file: 'check.py', kind: 'complete', find: 'shield.stats', offset: 7, limit: 60 } ];
// prec.mjs
const S = { 'python.analysis.extraPaths': ['pb'], 'python.analysis.stubPath': 'st', 'python.analysis.typeCheckingMode': 'strict',
            'python.analysis.diagnosticSeverityOverrides': { reportMissingImports: 'none' } };
const steps = [{ op: 'open', files: ['t.py'] }, { op: 'settle', files: ['t.py'], minMs: 12000, quietMs: 6000, maxMs: 90000 },
  { op: 'snapshot', name: 'main', files: ['t.py'], queries: ['mod_a', 'mod_b', 'mod_c', 'mod_s'].map((m) => ({ file: 't.py', kind: 'def', find: 'import ' + m, offset: 8 })) }];
const mk = (name, files) => ({ name, fixture: 'prec', steps, files: { '.vscode/settings.json': S, ...files } });
export const p1 = mk('p1', {});
export const p2 = mk('p2', { 'pyrightconfig.json': { extraPaths: ['pa'] } });
export const p3 = mk('p3', { 'pyrightconfig.json': {} });
export const p4 = mk('p4', { 'pyrightconfig.json': { typeCheckingMode: 'basic' } });
export const p5 = mk('p5', { 'pyproject.toml': '[tool.pyright]\nextraPaths = ["pc"]\n' });
export const p6 = mk('p6', { 'pyrightconfig.json': { extraPaths: ['pa'] }, 'pyproject.toml': '[tool.pyright]\nextraPaths = ["pc"]\n', '.vscode/settings.json': null });
export const p7 = mk('p7', { 'pyrightconfig.json': { extraPaths: ['pa'] }, '.vscode/settings.json': { ...S, 'python.analysis.pythonPlatform': 'Windows' } });
// fixture prec: t.py = "import mod_a / mod_b / mod_c / mod_s / nomod; def f(x): return x"; pa/mod_a.py, pb/mod_b.py, pc/mod_c.py, st/mod_s.pyi ("def s() -> int: ...")
````

Environment scenarios: `prepare: ["python3 -m venv .venv", ".venv/bin/python -m pip install --no-index --find-links <wheel cache> mpremote==1.29.0 -q"]`, `userSettings: {"python.useEnvironmentsExtension": true}` for v2/v3. Path scenarios: `wsDirName: 'CloudStorage/OneDrive-ExampleUniversity(student@example.edu)/ME 241 (Fall 2026)/Lab é1'` with and without `symlink: true`. Layout A text of `check.py`: imports `time os sys machine neopixel asyncio shield _shield mylib`, `from shield import Motor`, `import notamodule`, then `time.sleep_ms(10)`, `time.ticks_ms()`, `os.ilistdir("/")`, `os.uname()`, `sys.print_exception(Exception())`, `m = Motor(1)`, `m.bogus()`, `shield.nonexistent_function()`, `_shield.motor_setpoint(1)`, `machine.Pin(2, machine.Pin.OUT)`, `shield.stats()`, `mylib.greet("x")`, `mylib.nothere()`.
