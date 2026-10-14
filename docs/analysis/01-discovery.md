# 01 - Discovery: how the old extension finds Python and mpremote

Scope: user complaint 1, first half ("I created a `.venv`, installed `mpremote` in it, and the plugin did not find it").
Area owner: Python / mpremote discovery, invocation, caching, and the design of the replacement resolver.
Reference (read-only): `../mpy-workbench` (cited below as `old/`).

Confidence labels used throughout:

- **[E]** executed and observed (harness output reproduced in section 4 or 8).
- **[D]** diffed / measured on files on disk (byte-level facts).
- **[R]** read the code and I am confident, but did not execute it (usually because it needs Windows).
- **[K]** from my knowledge of Windows / macOS / VS Code behaviour, not verified here. Each has a way to verify.

Nothing here touched a serial port. `mpremote` was only ever run as `mpremote version` / `python -m mpremote version`.

---

## 0. Executive summary

1. **There are two different "old" builds, and the user ran the worse one.**
   The `.vsix` committed in `old/` (and installed in `~/.vscode/extensions/danielbucam.mpy-workbench-0.3.2`) is **not** built from git HEAD.
   The installed build runs the bare command `mpremote ...` everywhere (via `exec` and in terminals) and **never looks for a venv at all**.
   Git HEAD (`src/`, `dist/`) is a later, unreleased refactor (`7cb90c7`) that does `python -m mpremote`, but with a resolver that is broken in several independent ways.
   [D] sections 1 and 2.
2. **Why a workspace `.venv` is never found (installed build).** The extension shells out to `mpremote` and relies on `PATH`.
   A venv is only on `PATH` if it is *activated in that particular shell*. The extension host process is never activated, so every `exec('mpremote ...')` call (the whole sidebar: file tree, upload, download, list ports...) fails with `command not found`. [D][R]
3. **Why the HEAD resolver also fails (verified by execution).**
   - `validatePythonPath()` tests `execFile('mpremote', ['--version'])`, i.e. whatever `mpremote` is on `PATH`. It never tests the candidate interpreter. So a perfectly good `.venv/bin/python` that has `mpremote` installed is **rejected** unless a *global* `mpremote` also exists, and a wrong Python is **accepted** if a global `mpremote` exists. [E] S3, S4, S12
   - The user's actual setting `"mpyWorkbench.pythonPath": "${workspaceFolder}/.venv/bin/python"` (found in `~/src/mpy_test/.vscode/settings.json`) is passed to `execFile` as a **literal string**; VS Code does not expand `${workspaceFolder}` in extension settings, and the extension does not either. It fails with `ENOENT`. [E] S2
   - Everything failing silently collapses to `'python3'`, which is then cached (even the failure) for 30 s in a single global slot. [E] S1, S11
   - The "Install mpremote" notification is unreachable: `spawn mpremote ENOENT` does not contain `"not found"`. No UI is ever shown. [E] S12
4. **Windows is broken independently of discovery** in HEAD: commands are built with POSIX single-quote escaping and handed to `cmd.exe` (`exec`, REPL terminal) or PowerShell (`sendText`). Neither shell treats `'...'` as quoting. `'py -3'` is passed to `execFile` as one filename. [R] + Node source read [E]; needs a Windows VM to confirm by execution.
5. **Terminal commands and child_process calls resolve differently** (different PATH, different shells, different quoting). The resolver returns bare names like `python3` / `python`, which mean different things in the extension host, in `zsh -lc`, in PowerShell, and in `cmd.exe`. [E] (macOS PATH comparison).
6. **Recommendation for the new resolver** (details in section 8): validate the *candidate itself* (`python -I -c <probe>` that imports `importlib.metadata.version("mpremote")`), return a structured launcher `{exe, prefixArgs}` (never a command string), spawn with `execFile` / `createTerminal({shellPath, shellArgs})` (no shell, no quoting), cache per workspace folder with explicit invalidation, never silently fall through from an explicit setting, and ship a one-click "create `.venv` + pip install mpremote" fix. A working prototype of the probe/layout/classification logic was executed against the real `~/src/mpy_test/.venv` (finds Python 3.13.13 + mpremote 1.29.0 in ~110 ms with `PATH=/usr/bin:/bin`). [E] section 8.9
7. **Update from the real-host follow-up (last section of this file):** for this user the Python Environments extension, not the Python extension, owns discovery (A/B-experiment assignment `python.useEnvironmentsExtension = true`). Neither extension's API is ready at activation (the Python API returns the bare string `"python"` for up to ~10-35 s on this machine; Envs `getEnvironment` can return `undefined` after its 1 s cap), they can disagree with each other, and in an untrusted workspace both extensions are absent. Candidate #3 in 8.2 and the invalidation list in 8.5 were revised; the local-venv probe (candidate #2) remains the only source that was correct at t=0 in every regime.

---

## 1. What actually shipped: `.vsix` vs git HEAD vs `src/` vs `dist/` vs installed

### 1.1 Facts

| Artifact | What it is | Evidence |
|---|---|---|
| `old/src/*.ts` | Source at git HEAD `7cb90c7` ("Refactor mpremote command execution to use Python interpreter", 2026-04-04). | `git log` |
| `old/dist/*.js` | Compiled output of that same HEAD. I recompiled `src/` into the scratchpad with the old `tsc` and compared: `pythonInterpreter.js`, `mpremote.js`, `mpremoteCommands.js`, `monitor.js`, `pyraw.js`, `extension.js` are **identical** to `old/dist`. | [D] |
| `old/mpy-workbench-0.3.2.vsix` | **Older build than HEAD.** Its `dist/mpremote.js` and `dist/mpremoteCommands.js` differ from HEAD; it runs bare `mpremote` (see 1.2). Commit `7cb90c7` claims to have "Updated mpy-workbench-0.3.2.vsix" but the binary is the same size (5,033,026 bytes before and after) and its contents show the pre-refactor code. | [D] `unzip -p` + `diff` |
| `~/.vscode/extensions/danielbucam.mpy-workbench-0.3.2/` | Identical to the `.vsix` **except** `dist/mpremoteCommands.js`, which the user hand-edited (see 1.3). | [D] `diff -rq` |
| `old/dist/pathUtils.js`, `pathUtils.test.js` | Orphans. Nothing `require`s them, there is no `src/pathUtils.ts`, and `git log --all -- src/pathUtils.ts` is empty. Left over from an uncommitted working copy. Harmless but shows `dist/` is not a clean build product. | [D] grep |
| `.vsix` payload | Contains a developer's **macOS-only `.venv/`** (Python 3.9.6 from CommandLineTools, `pip 25.2`, `rshell`, `pyserial`, `pyboard`; notably *no* `mpremote`) because `.vscodeignore` has no `.venv/**` rule. 772 files, 11.6 MB unpacked. Never used by the code. | [D] `unzip -l` |
| `.vsix` payload | Ships `scripts/mpremote_tool.py`, which is not in the repo (the repo's `.gitignore` contains `*.py`). | [D] |

**Answer to "which one actually shipped in the installed extension":** the installed copy is the **pre-7cb90c7 `.vsix` build** (bare `mpremote`), plus the user's hand edit. Git HEAD's `python -m mpremote` logic has never been what the user ran. The user's `mpyWorkbench.pythonPath` setting therefore had **no effect on any mpremote call** in the installed build.

### 1.2 What the installed (.vsix) build does

All three call sites build a bare `mpremote` command:

- Sidebar and all file ops: `exec('mpremote "connect" "<port>" "fs" "ls" ":"')` (the VSIX `dist/mpremote.js` ~L176-184; double-quoted args, which does work in both `sh` and `cmd.exe`). I loaded the VSIX `dist/mpremote.js` under the vscode mock and captured the string: `mpremote "connect" "/dev/cu.usbserial-FAKE" "fs" "ls" ":"` (darwin) and `mpremote "connect" "COM3" "fs" "ls" ":"` (win32, via `cmd.exe /d /s /c`). [E]
- REPL terminal: `createTerminal({shellPath: $SHELL, shellArgs: ["-lc", "mpremote connect <port>"]})`. [E]
- Run file: `terminal.sendText('mpremote connect <port> run "<file>"')` into a default-shell terminal named "ESP32 Run File". [E]
- Startup check: `exec('mpremote --version')` and a Spanish toast "mpremote no encontrado. Instalalo con: pip install mpremote".
- `PythonInterpreterManager` is `require`d only by `extension.js` (to call `clearPythonCache`), `monitor.js` (not imported anywhere) and `pyraw.js` (only used when `usePyRawList` is true, and it points at a script, `thonny_list_files.py`, that does not exist). [D] grep

So in the installed build, discovery of a `.venv` is **not implemented**; `mpremote` is found only if it is on the `PATH` of (a) the extension host process, (b) the login shell used by the REPL terminal, (c) the interactive shell of the Run File terminal.

### 1.3 The user's hand edit (evidence of what they tried)

File timestamps (all 2026-10-12): venv created 11:43, `mpremote 1.29.0` installed 11:44, VSIX installed 11:49, `esptool` installed 11:53, `.vscode/settings.json` written 12:10, edits to the installed `dist/mpremoteCommands.js` at 12:33, 12:35, 12:37 (backups `.bak`, `.bak2` kept).

Diff of the hand edit (installed `dist/mpremoteCommands.js` vs the VSIX original):

```
L50  (restartReplInExistingTerminal)  const cmd = `~/src/mpy_remote/.venv/bin/python -m mpremote connect ${device}`;   // ~/src/mpy_remote does NOT exist
L246 (getReplTerminal)                const cmd = `~/src/mpy_test/.venv/bin/python -m mpremote connect ${device}`;
```

Consequences, all consistent with the user's report: [D][R]

- Only the REPL command was patched, and only in one project. Every `exec` call (tree, upload, `fs stat` used by Run File, port listing) and the Run File terminal still use bare `mpremote`.
- The REPL path works only if the terminal's shell can expand `~` (it can in `zsh -lc`), and only for the one project hard-coded in the file.
- The `strictConnectHandshake` path (command `mpyWorkbench.openSerial`) first does `mp.reset()` + `mp.ls("/")` through `exec('mpremote ...')`, which fails, so the REPL never opens via that command. The sidebar "Open Repl" button calls `getReplTerminal` directly (no handshake) which is the one that was patched.
- Run File: `runActiveFile` first calls `mp.fileExists()` (an `exec`, fails, error swallowed), falls back to `mpremote connect <port> run "<file>"` typed into a terminal where `mpremote` is not on `PATH` (a venv that was never activated) -> `command not found`. Also, it refuses to run at all while `mpyWorkbench.connect` is `auto` (`mpremoteCommands.ts:170-173`), with only a toast.

### 1.4 The user's `.vscode/settings.json` (found, read-only)

`~/src/mpy_test/.vscode/settings.json`:

```json
{ "mpyWorkbench.pythonPath": "${workspaceFolder}/.venv/bin/python" }
```

and `~/src/mpy_test/.venv` is a Homebrew `python@3.13` venv with `mpremote 1.29.0`, `pyserial 3.5`, `esptool 5.5.0`; `bin/mpremote` has the shebang `#!~/src/mpy_test/.venv/bin/python3.13`. This machine has **no global `mpremote`** (`which -a mpremote` is empty) and no `py`, `pipx`; `python` on the shell PATH is PlatformIO's penv python. [E]

---

## 2. The old resolver, step by step (git HEAD `src/pythonInterpreter.ts`)

`PythonInterpreterManager.getPythonPath(workspaceFolder?)`:

| Step | Lines | Behaviour |
|---|---|---|
| Cache | `:12-14, :25-28` | One static slot (`cachedInterpreter`, `lastCacheTime`), TTL 30 s (`CACHE_DURATION = 30000`). **Not keyed** by workspace folder, settings, or platform. |
| Method 0: `mpyWorkbench.pythonPath` | `:32-50, :158-165` | `getConfiguration('mpyWorkbench', ws.uri).get('pythonPath')`, trimmed. **No variable expansion, no `~`, no relative-path resolution.** Validated via `validatePythonPath`. If invalid and not "missingMpremote": silently falls through (`:46`). |
| Method 1: Python extension | `:52-67, :113-153` | `getExtension('ms-python.python')`, `activate()`, then `exports.settings.getExecutionDetails(uri).execCommand[0]`, else legacy `exports.getActiveInterpreter(uri).path`. Does **not** use `exports.environments` (the supported API), does not listen to `onDidChangeActiveEnvironmentPath`. |
| Method 2: settings | `:69-84, :170-194` | `mpyWorkbench.pythonPath` **again** (so the override is validated a second time), then `python.defaultInterpreterPath`, then deprecated `python.pythonPath`. No variable expansion. |
| Method 3: fallbacks | `:86-102, :199-224` | macOS/Linux: `python3`, `python`, `/usr/bin/python3`, `/usr/local/bin/python3`, `/opt/homebrew/bin/python3`, `/usr/bin/python`, `/usr/local/bin/python`. Windows: `python`, `python3`, **`'py -3'`**, `'py'`, then `%LOCALAPPDATA%\Programs\Python\Python39..Python312\python.exe` (3.13+ missing; `C:\Program Files\Python3xx` missing). **No workspace-local venv candidate exists anywhere in the list.** |
| Last resort | `:104-107` | Returns `'python3'` (on Windows too) and **caches it** for 30 s. |
| Validation | `:229-249` | `execFile(candidate, ['-c','import sys; print(sys.version)'], {timeout:5000})`, **then `execFile('mpremote', ['--version'])`** (`:235`). The second call ignores `candidate` completely. |
| "Missing mpremote" detection | `:242` | `errorMessage.includes('mpremote') && (includes('not found') || includes('command not found'))`. Node's error for a missing executable is `spawn mpremote ENOENT` -> never matches. |
| Install prompt | `:254-334` | Unreachable (above). If it were reachable: `exec(`${pythonPath} -m pip install mpremote`)` with no quoting (spaces in the path break it), then tells the student to "Restart VS Code". |
| Cache clearing | `extension.ts:890-893` | Only on `mpyWorkbench.pythonPath` config change (and after the unreachable install). **Not** on `python.defaultInterpreterPath`, interpreter selection, workspace-folder changes, trust changes, or a venv being created. |
| Dead code | `:356-371, :376-390` | `PythonInterpreterManager.checkMpremoteAvailability` (the one `extension.ts` calls is a different function in `mpremoteCommands.ts:75`) and `getPythonCommandForTerminal` (its second `if` can never run). |

Callers (all pass `workspaceFolders?.[0]`, never the folder that owns the active file):

- `mpremote.ts:172-181` `runMpremote`: `exec(`${shellEscape(python)} -m mpremote ${args.map(shellEscape)}`)`.
- `mpremoteCommands.ts:12-17` `buildMpremoteTerminalCommand` (REPL, Run File, soft reset, restart-REPL).
- `mpremoteCommands.ts:75-108` startup check `execFile(python, ['-m','mpremote','--version'])`.
- `pyraw.ts:15` and `monitor.ts:50` call `getPythonPath()` with **no** folder.
- `extension.ts:38` runs the startup check at activation; activation event is `onLanguage:python` only (`package.json:24-26`).

---

## 3. Root-cause analysis for complaint 1

Ranked. "Confidence" is that this defect exists as stated; "likelihood" is how much of the user's pain it explains.

| # | Defect | Build | Confidence | Likelihood it caused the report |
|---|---|---|---|---|
| RC1 | Bare `mpremote` on `PATH`; venv never considered; `mpyWorkbench.pythonPath` ignored for all mpremote calls | installed `.vsix` | High [D][E] | **Primary** - this is what the user actually ran |
| RC2 | Validation tests global `mpremote`, not the candidate -> good venv rejected / bad python accepted | HEAD | High [E] | Primary for HEAD |
| RC3 | `${workspaceFolder}` / relative / `~` not expanded in `mpyWorkbench.pythonPath` and `python.defaultInterpreterPath` | HEAD | High [E] (and the user's file has the literal) | High - their own setting hits it |
| RC4 | Silent fall-through to `python3`; failures cached 30 s; no single-flight (5 concurrent callers spawn 55 processes) | HEAD | High [E] | High - produces confusing "No module named mpremote" later, and masks fixes |
| RC5 | "Install mpremote" prompt is dead code (error-text match never succeeds) | both | High [E] | Medium - students get no guidance |
| RC6 | POSIX single-quote escaping fed to `cmd.exe` / PowerShell; `'py -3'` as one filename; hard-coded Python39-312; `'python3'` last resort on Windows | HEAD | High [R]; not executed | **Critical for Windows** |
| RC7 | Terminal commands and child_process calls resolve differently (login shell vs extension host PATH, three different shells) | both | High [E] | Medium - "REPL unreliable" |
| RC8 | Multi-root: always `workspaceFolders[0]`, and one global cache slot | HEAD | High [E] | Low for the class, bad for anyone with two folders |
| RC9 | Python-extension API use: deprecated `settings.getExecutionDetails`, returns bare `"python"` by default, activation race, no change events, throws in untrusted workspaces | HEAD | High (bundle read) [E] | Medium |
| RC10 | `python -m mpremote` runs with cwd = workspace in the Run File terminal and without `-I` -> a student file named `platformdirs.py` / `serial.py` / `mpremote.py` breaks mpremote | HEAD | High [E] | Low-Medium; classic "works until the student names a file `serial.py`" |
| RC11 | Workspace-controlled interpreter path is executed in an "untrusted workspace supported" extension (`package.json` `capabilities.untrustedWorkspaces.supported: true`) | both | High [R] | Security, not UX |
| RC12 | No `windowsHide`, no process-tree kill, 5 s validation timeout that is too short for first-run AV scanning | HEAD | Medium [R][K] | Windows-only flakiness |

How each could be refuted: RC1 - install the VSIX on a clean profile, create `.venv` + `pip install mpremote`, open the folder, click refresh: expect `/bin/sh: mpremote: command not found` in the toast. RC2 - run the harness in 4.3 (reproduces without VS Code).

---

## 4. Verification by execution

### 4.1 Harness (all under the scratchpad, nothing in `old/` modified)

Scratchpad: `<scratchpad>`

- `h/src` = copy of `old/src`; `h/out-head` = compiled with `old/node_modules/.bin/tsc` (exit 0; output byte-identical to `old/dist` for the six files above).
- `h/stubs/vscode/index.js` = hand-written vscode mock. `workspace.getConfiguration().get()` returns the raw string with **no `${workspaceFolder}` substitution**. That matches VS Code's documented behaviour (the configuration API does no variable substitution; each extension must do its own, as the Python extension does) but the mock is my own, so that specific point is **[K]**; to confirm in a live window, log `getConfiguration('mpyWorkbench').get('pythonPath')` with the user's settings file.
- `h/run.js` = drives the real compiled `PythonInterpreterManager` and logs every `execFile` it makes (by wrapping `child_process.execFile`, including its `util.promisify.custom`).
- `h/run2.js` = loads a dist dir (HEAD or the extracted VSIX) with `child_process.exec/execFile/spawn` replaced by recorders (nothing is executed), forces `process.platform` to `darwin` or `win32`, and prints the exact command strings / terminal options each code path would use.
- `fx/` = fixtures: `ws1/.venv` (fake python that has the mpremote module), `ws2/.venv` (fake python, **no** module), `ws_space/my proj/.venv`, `ws_win/.venv/Scripts/python.exe`, a OneDrive-style path with spaces, `sysbin` (fake system `python3`/`python`, no mpremote), `globalbin/mpremote` (fake global console script), `stubbin` (Microsoft Store stub, xcode-select shim, hanging python).
- `vsix/` = the `.vsix` extracted. `proto/` = the prototype of the new resolver (section 8.9).

Re-run: `cd $SCR/h; NODE_PATH=$SCR/h/stubs PATH="$SCR/fx/sysbin:/usr/bin:/bin" node run.js S3_absolute_setting` (see scenario names in `run.js`).

### 4.2 `PATH` regimes

- **P0** = `$SCR/fx/sysbin:/usr/bin:/bin` - no global `mpremote` (this is the user's real situation; `mpremote` exists only inside the venv).
- **P1** = `$SCR/fx/globalbin:` + P0 - a global `mpremote` console script exists (e.g. `pipx install mpremote`).

### 4.3 Results (old HEAD resolver)

| Scenario | PATH | Setting / API | Result | Observation |
|---|---|---|---|---|
| S1 nothing configured, ws1 has `.venv` with mpremote | P0 | - | `"python3"` | 11 spawns, every `mpremote --version` is `spawn mpremote ENOENT`. `.venv` is never probed - it is not a candidate. |
| S1 | P1 | - | `"python3"` | Accepted because the *global* mpremote exists, even though that python3 has no `mpremote` module. `python3 -m mpremote` would then fail with "No module named mpremote". |
| S2 user's literal setting | P0 | `mpyWorkbench.pythonPath=${workspaceFolder}/.venv/bin/python` | `"python3"` | `spawn ${workspaceFolder}/.venv/bin/python ENOENT` (validated twice: Method 0 and Method 2). |
| S3 correct absolute setting, venv has mpremote | P0 | `mpyWorkbench.pythonPath=<abs ws1 venv python>` | `"python3"` | `python -c` OK, then `spawn mpremote ENOENT` -> **rejected the correct interpreter**. Tried twice, then all fallbacks. |
| S4 absolute setting, venv python **lacks** the module | P1 | `<abs ws2 venv python>` | `"<ws2 venv python>"` | **Accepted** a python that cannot run `-m mpremote`. |
| S5 Python extension returns the venv python | P0 | `getExecutionDetails -> [<abs venv python>]` | `"python3"` | Same global-mpremote rejection. |
| S6 Python extension returns bare `"python"` (its default) | P1 | `execCommand:['python']` | `"python"` | Returns a bare name; in the terminal it is resolved by a different shell/PATH (4.5). |
| S7 relative `python.defaultInterpreterPath=.venv/bin/python`, cwd=`/` | P0 | - | `"python3"` | `spawn .venv/bin/python ENOENT` - resolved against the extension host's cwd, not the workspace. |
| S8 `python.defaultInterpreterPath=${workspaceFolder}/...` | P0 | - | `"python3"` | Literal `${workspaceFolder}` again. (The Python extension itself *does* expand it; this extension does not.) |
| S9 no workspace folder | P0 | - | `"python3"` | Runs, no workspace-local logic anyway. |
| S10 multi-root: ws1 then ws2 | P1 | python ext returns `<folder>/.venv/bin/python` | ws1 -> ws1 venv; ws2 -> **ws1 venv** (0 spawns) | Cache is global: the second folder gets the first folder's interpreter for up to 30 s. And callers only ever pass `workspaceFolders[0]` anyway. |
| S11 negative caching | P0 | python ext changes to a valid venv after first failure | 2nd call returns `"python3"` with 0 spawns | The failure (last resort) is cached for 30 s. |
| S12 internals | P0 | - | `validatePythonPath(<good venv python>)` -> `{"valid":false,"missingMpremote":false,"error":"spawn mpremote ENOENT"}`; for a nonexistent path and for `"py -3"` -> `spawn py -3 ENOENT` | Direct proof of RC2 and RC5. **No UI message was produced.** |
| S13 path with a space | P1 | abs setting under `.../my proj/...` | OK for `execFile`; exec string is `'<path with space>/.venv/bin/python' -m mpremote 'connect' 'COM3' 'fs' 'ls'` | Fine under `sh`; see 4.4 for `cmd.exe`. |
| S14 5 concurrent `getPythonPath()` at startup | P0 | - | all `"python3"`, **55 spawns** | No single-flight: each caller repeats the whole chain (11 spawns) until one finishes and caches. On Windows with AV latency this multiplies. |

### 4.4 Command construction (nothing executed; `process.platform` forced)

HEAD, with `mpyWorkbench.pythonPath` set to a valid absolute path under a folder with a space:

| Path | darwin | win32 |
|---|---|---|
| `runMpremote` (`exec`) | `/bin/sh -c "'/Users/student/My Project/.venv/bin/python' -m mpremote 'connect' '/dev/cu...' 'fs' 'ls' ':'"` - OK | `cmd.exe /d /s /c "'C:\Users\Student\My Project\.venv\Scripts\python.exe' -m mpremote 'connect' 'COM3' 'fs' 'ls' ':'"` - **broken** |
| REPL terminal (`mpremoteCommands.ts:254-258`) | `shellPath=/bin/zsh shellArgs=["-lc","'<py>' -m mpremote 'connect' '<port>'"]` - OK | `shellPath=cmd.exe shellArgs=["/d","/c","'<py>' -m mpremote 'connect' 'COM3'"]` - **broken** |
| Run File (`sendText` into default shell) | `'<py>' -m mpremote 'connect' '<port>' 'run' '<file>'` into zsh - OK | same string into **PowerShell** (default on Windows) - **parse error** ("Unexpected token '-m' in expression or statement": a quoted string at the start of a statement is an expression; needs `& `) [K] |

Why the win32 column is broken:

- I read Node's own `child_process` source in the running binary (`process.binding('natives').child_process`, Node 26.5): on Windows `exec` runs `process.env.comspec || 'cmd.exe'` with `['/d','/s','/c', '"<command>"']` and `windowsVerbatimArguments = true`. [E]
- `cmd.exe` has no single-quote quoting. `'C:\Users\Student\My` is taken as the program name (split at the first space), or `'C:\...\python.exe'` as a filename containing quote characters. Python's argv parser on Windows only honours double quotes, so even if it got started `mpremote` would receive the arguments `'connect'` and `'COM3'` with literal quotes. [R]
- This is a regression in `7cb90c7`: the VSIX build used `"..."` quoting which is valid in `sh` and `cmd.exe`.
- The README itself lists "Full Windows validation" as an open TODO (README roadmap), so Windows has never been verified by the author.

I could not run `cmd.exe` or PowerShell here, so the win32 column is **[R]/[K]**. Verify on any Windows VM by pasting the printed strings.

### 4.5 Terminal vs child_process resolve differently (macOS evidence)

On this Mac:

```
PATH of the process running this session (stand-in for an extension host that inherited an interactive shell's PATH):  python -> ~/.platformio/penv/bin/python ; python3 -> /usr/local/bin/python3
env -i ... /bin/zsh -lc  (what the REPL terminal runs):  python -> (not found) ; python3 -> /usr/local/bin/python3
```

[E] So if the resolver returns the bare name `python` (as S6 does), `exec` (extension host PATH) and the REPL terminal (`-lc`, non-interactive login: reads `.zprofile` but not `.zshrc`, where pyenv/conda/PlatformIO shims usually live) disagree. The Run File terminal is a third environment: an interactive shell, possibly auto-activated by the Python extension (`python.terminal.activateEnvironment` default `true`, scope `resource`, bundle read [E]), possibly not.

Matrix:

| Mechanism | Shell | PATH source | Quoting needed | Sees activated venv? |
|---|---|---|---|---|
| `exec()` (sidebar ops) | `/bin/sh -c` (mac) / `cmd.exe /d /s /c` (win) | extension host env | sh vs cmd rules | **No, never** |
| `execFile()` (validation) | none | extension host env (+ `.exe` search on Windows) | none | No |
| REPL terminal | `$SHELL -lc` (mac) / `cmd.exe /d /c` (win) | login-shell env (mac) | sh vs cmd | No |
| Run File terminal | user's default shell: zsh/bash (mac), **PowerShell** (win) | interactive shell + possible Python-ext activation | zsh vs PowerShell | Maybe (and on Windows `Activate.ps1` is blocked by the default execution policy [K]) |

---

## 5. Specific cases requested

- **Relative `python.defaultInterpreterPath`.** Old code: used as-is, resolved by the OS against the extension host's cwd (`/` on macOS Dock launches, `C:\Windows\System32` or the VS Code install dir on Windows) -> ENOENT. [E] S7. The Python extension itself resolves it: `_(e,t)` in its bundle returns `path.resolve(workspaceRoot, p)` when the value contains a separator and is not absolute; it also runs `SystemVariables.resolveAny` so `${workspaceFolder}` works there. [E] (Python ext 2026.8.0 bundle read).
- **`${workspaceFolder}`.** Not expanded by VS Code for arbitrary extension settings, not expanded by this extension. [E] S2/S8. The new extension must implement expansion itself (`${workspaceFolder}`, `${workspaceFolder:name}`, `${userHome}`, `${env:NAME}`, `${pathSeparator}`/`${/}`, leading `~`).
- **No workspace folder open.** Old code passes `undefined`; candidates are the global ones only; result `python3` with no UI. The extension's tree/sync features need a folder anyway (`getWorkspaceFolder()` throws "No workspace folder open"). [E] S9, [R]
- **Multi-root.** Always `workspaceFolders[0]` (`mpremote.ts:174`, `mpremoteCommands.ts:13,77,186`); one global cache slot. [E] S10
- **Python extension API (installed ms-python.python 2026.8.0, bundle read).**
  - `exports.settings.getExecutionDetails(resource)` returns `{execCommand: pythonPath === "" ? undefined : [pythonPath]}` where `pythonPath = getSettings(resource).pythonPath` = `resolveAny(interpreterPathService.get(root))`; the settings object initialises `_pythonPath = "python"` and only swaps in the auto-selected interpreter when the value is empty or exactly `"python"` and autoselection has already run. Before discovery completes you get the bare string `"python"`. [E]
  - `exports.environment.getExecutionDetails` / `getActiveEnvironmentPath` are flagged `deprecated.*` and log "extension is using deprecated python APIs which will be removed soon". [E]
  - The supported API is `exports.environments`: `getActiveEnvironmentPath(resource)` (sync, returns `{id, path}`), `resolveEnvironment(env)` (async; returns `executable.uri`, which is **`undefined` when the executable is the bare name `python`**), `onDidChangeActiveEnvironmentPath`. `resolveEnvironment` throws `"Not allowed to resolve environment in an untrusted workspace"`. [E]
  - Python ext activates on `workspaceContains:.venv` (among others), so in a `.venv` workspace it is usually up early, but not necessarily before our activation. `python.useEnvironmentsExtension` (default `false`) can route to the separate "Python Environments" extension (`ms-python.vscode-python-envs`, also installed here). [E]
- **Terminal vs child_process.** See 4.4 and 4.5.
- **Cache.** Single slot, 30 s, global, caches failures, cleared only by `mpyWorkbench.pythonPath` change. See section 2.

---

## 6. Windows details the old code gets wrong (and what the new code must do)

| Topic | Old behaviour | Required behaviour |
|---|---|---|
| venv layout | Not probed | `.venv\Scripts\python.exe` (not `bin/`). Conda envs: `<env>\python.exe` (no `Scripts`) - get these from the Python-extension API, don't guess. |
| `py -3` | Passed to `execFile` as one string -> `ENOENT` (verified `spawn py -3 ENOENT`, [E]) | Represent as `{exe:"py", prefixArgs:["-3"]}`; then resolve to an absolute `sys.executable` and use that. `py.exe` is installed by the python.org installer (default on) **independently** of "Add python.exe to PATH" (which is off by default on older installers), so `py` is the most reliable discovery on student laptops. Not installed by the Microsoft Store Python. [K] |
| App Execution Aliases | `python` / `python3` are the first fallbacks | `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` is a 0-byte alias stub. With no real Python it prints "Python was not found; run without arguments to install from the Microsoft Store..." and exits 9009; run with no arguments it can open the Store. Never run a bare `python`; always pass `-c`; classify exit `9009` or that text as `store-stub`. Do **not** reject by path: a real Store-installed Python is launched through the same alias. [K] - prototype classification of the message/exit code was exercised with a fake stub [E] |
| Hard-coded dirs | `Python39..Python312` under `%LOCALAPPDATA%\Programs\Python` | Glob `%LOCALAPPDATA%\Programs\Python\Python3*`, `C:\Program Files\Python3*`, newest first; plus `py -0p` output. |
| Quoting | `'...'` for cmd.exe/PowerShell | No shell. `execFile(exe, [...args])`; terminals via `shellPath` + `shellArgs` array. |
| Spaces / OneDrive / non-ASCII | Breaks in the shell string; install prompt unquoted | Arrays everywhere. Fixture `ws_win_space/Jane Doe/OneDrive - School/lab1` passes the prototype [E]. Probe prints `json.dumps` (ASCII-escaped) so non-ASCII paths round-trip. |
| PowerShell execution policy | Run File types into PowerShell; Python ext may try to dot-source `Activate.ps1` | Default policy on Windows client is `Restricted`: `.ps1` blocked ("running scripts is disabled on this system"). Never depend on activation. Executables (`python.exe`) are not subject to the policy. [K] |
| Antivirus latency | 5 s validation timeout (`:232,:235`) | First spawn of a fresh `python.exe` or after pip writes thousands of files can take several seconds under Defender real-time scanning. First probe 20 s, later 8 s, one automatic retry on timeout, show "Checking Python..." in the status bar, never report "not found" on a timeout. [K] |
| Console window flashes | `exec`/`execFile` without `windowsHide` | `windowsHide: true` on every spawn. [R] (`mpremote.ts:134-140` has no `windowsHide`) |
| Killing processes | `child.kill()` | `taskkill /PID <pid> /T /F` for process trees (venv launcher stubs, pip subprocesses). |
| `.cmd`/`.bat` shims | n/a | Node >= 18.20.2 / 20.12.2 refuses to spawn `.cmd`/`.bat` without `shell:true` (CVE-2024-27980). pip's `mpremote.exe` is a real exe; pipx/uv shims are exes. Don't depend on `.cmd`. [K] |
| Managed machines | not considered | AppLocker/WDAC may block `python.exe` in a user-writable folder (`.venv`). Surface the OS error text verbatim in diagnostics. [K] open question |
| Encoding | `PYTHONIOENCODING=utf-8` set (good, keep) (`mpremote.ts:137`) | Also `-X utf8` / `PYTHONUTF8=1`. mpremote 1.29 additionally calls `ConsoleWindows.configure_unicode_output()` on win32 (`mpremote/main.py` `main()`), older versions don't. |
| macOS equivalents | `/usr/bin/python3` is a candidate | If Command Line Tools / Xcode are absent, executing the `/usr/bin/python3` shim pops the macOS "install developer tools" dialog (stderr `xcode-select: note: No developer tools were found, requesting install.`). Probe `xcode-select -p` (or stat `/Library/Developer/CommandLineTools/usr/bin/python3`) before spawning it. [K]; classification of the stderr text exercised [E] |
| macOS Homebrew | `pip install` globally | Homebrew/Debian Pythons are PEP 668 "externally managed": global `pip install mpremote` fails. This is another reason the fix must create a venv, not global-install. [K] |

---

## 7. Other findings in this area

1. **`-I` (isolated mode) matters.** Executed with the real venv: with `platformdirs.py` in the cwd, `python -m mpremote version` crashes with the student file's exception; with `-I` it prints `mpremote 1.29.0`; `PYTHONPATH` poisoning is likewise defeated by `-I`; the console script is immune because `sys.path[0]` is the script dir. [E] (tests 4-7 in the transcript summarised in 8.3). HEAD's Run File terminal sets `cwd` to the workspace root (`mpremoteCommands.ts:220-224`), exactly where student files live.
2. **Messages are in Spanish** (`mpremoteCommands.ts:82,91,103`, `pythonInterpreter.ts` strings) in an English-language class.
3. `scripts/check_python_deps.py` is unreferenced anywhere (and also shells out to bare `mpremote`).
4. `pyraw.ts:12` points at `scripts/thonny_list_files.py`, which does not exist (`usePyRawList` can never work).
5. `monitor.ts:51` `spawn(...)` has no `'error'` listener; a missing interpreter would raise an unhandled `'error'` event (dead code today).
6. The startup check runs on `onLanguage:python` only; the sidebar can be used earlier (implicit `onView` activation), so students who open the folder but no `.py` file get no early diagnosis.
7. Likely contributor to "REPL not reliable", outside my area but caused by how it is launched: the REPL terminal *is* the mpremote process (`zsh -lc "<cmd>"` execs the command), and `restartReplInExistingTerminal` (`mpremoteCommands.ts:37-49`) tries to restart it by `sendText(cmd)` into that same terminal; after Ctrl-X the process (and shell) has exited, so there is nothing to type into. Also Ctrl-C / Ctrl-B are `sendText`-ed 500 ms after creation (`:260-271`): if Python + mpremote import is still starting (first run, AV), Ctrl-C reaches the pty in cooked mode and raises SIGINT in the importing process. [R], medium confidence; verify by delaying startup (e.g. `python -c "import time; time.sleep(1)"` before `-m mpremote`).
8. `package.json` declares `"capabilities.untrustedWorkspaces.supported": true` (`:14-18`) while `mpyWorkbench.pythonPath` (workspace-scoped by default, `:406-410`) lets a cloned repo's `.vscode/settings.json` choose which executable the extension runs. For a class that distributes starter projects this should be `"limited"` with `restrictedConfigurations: ["mpyWorkbench.pythonPath", ...]`. [R]

---

## 8. Design of the ideal resolver (new extension)

### 8.1 Principles

1. **Validate the thing you will run.** A candidate is "good" only if running *it* proves `mpremote` is importable. Never test a different binary than the one you will launch.
2. **Return a launcher, not a string.** `{exe, prefixArgs[], kind, pythonVersion, mpremoteVersion, sourceLabel}`. No quoting problems exist because there is no shell.
3. **No shell, ever** for programmatic calls: `execFile`/`spawn` with an args array. For terminals use `createTerminal({shellPath: exe, shellArgs: [...prefixArgs, "-I", "-m", "mpremote", ...]})` so cmd.exe/PowerShell/zsh/login-shell differences cannot matter and no `sendText` race exists.
4. **Never depend on activation or PATH** except as a last discovery source.
5. **Explicit beats implicit, and an explicit failure is an error**, not a silent fall-through.
6. **Every rejection has a recorded reason** that can be shown to the student and printed for the teacher.
7. **Self-heal.** A command failure that looks like an environment problem invalidates the cache and re-resolves once before surfacing an error.

### 8.2 Ordered candidate list

Resolution context: `folder` = the workspace folder that owns the active editor's file (else the folder remembered in `workspaceState` as the "board project", else the first folder; none is allowed). `trusted` = `workspace.isTrusted`.

| # | Candidate | How to obtain | Notes |
|---|---|---|---|
| 1 | **Explicit `mpyWorkbench.pythonPath`** (resource-scoped) | expand variables, `~`, relative -> against `folder` | If set and it fails validation: **stop**, report `SETTING_INVALID` with the expanded path and the reason; offer "Clear setting" / "Use automatic". Skipped in untrusted workspaces (restricted configuration). Optional `mpyWorkbench.mpremotePath` for a standalone executable. |
| 2 | **Workspace-local venv** | for `folder` (and walking up from the active file's directory to the folder root, then other folders): dirs `.venv`, `venv`, `env`, `.virtualenv` that contain `pyvenv.cfg`; Windows `Scripts\python.exe`; POSIX `bin/python` then `bin/python3` | Trusted workspaces only. This is the class's expected path ("create `.venv` in the project folder"). Require `pyvenv.cfg` so a plain directory named `env` is not mistaken for a venv. |
| 3 | **Interpreter chosen by Python tooling (hint, never authoritative, never blocking)** - **REVISED by the "Follow-up: Interpreter-resolution API ground truth" section at the end of this file (F.7); the original text of this row was wrong for this user.** | 3a explicit `python.defaultInterpreterPath` (raw value, own variable expansion; `""`/`"python"` = unset); 3b Python Environments API `getEnvironment(folderUri)` when that extension's `exports` exists (`undefined` = "not ready", not "none"); 3c Python extension `environments.getActiveEnvironmentPath(folderUri)` rejecting `DEFAULT_PYTHON`/bare names/non-existent paths. No deprecated `settings.getExecutionDetails`. Every candidate goes through the same probe as the others. Skipped when untrusted (both extensions are absent from the extension host then). | Race each API against ~1.5 s then move on; subscribe to `envs.onDidChangeEnvironment` and `python.environments.onDidChangeActiveEnvironmentPath` and re-resolve on events using the event payload (the getter lags the first event). Details, measurements and the disagreement cases are in F.3-F.7. |
| 4 | **Extension-managed venv** | `context.globalStorageUri/venv` (created by the one-click fix when no folder is open, or the project venv can't be used e.g. OneDrive lock) | Gives "just works" without a folder and survives students deleting/moving project folders. |
| 5 | **Windows `py` launcher** | `{exe:"py", prefixArgs:["-3"]}`, resolve once to `sys.executable` | Strip `VIRTUAL_ENV`, `PY_PYTHON` from the probe env for determinism. |
| 6 | **`python3` / `python` on PATH** + well-known absolute locations | mac: `python3`, `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `/Library/Frameworks/Python.framework/Versions/Current/bin/python3`, and `/usr/bin/python3` only after the Command Line Tools check (pyenv shims are skipped: they are wrappers, not interpreters, and are slow). Windows: `python`, `python3`, `%LOCALAPPDATA%\Programs\Python\Python3*\python.exe`, `C:\Program Files\Python3*\python.exe` | Treat `store-stub`/`macos-clt-shim`/timeouts as "not found" with a recorded reason. |
| 7 | **Standalone `mpremote` executable** | `where`/`which mpremote`, `~/.local/bin`, `%USERPROFILE%\.local\bin`, pipx (`PIPX_BIN_DIR`), `uv tool dir --bin`, `/opt/homebrew/bin` | Launcher kind `console-script` (run directly, no `-m`). Last because no interpreter is known for the install flow. |
| 8 | *(optional tier, recommended - see 8.8)* **Bundled mpremote zipapp** run by any Python >= 3.8 found in 3-6 | `<ext>/python/mpremote.pyz` (pure-python mpremote + pyserial + platformdirs, pinned) -> `python -I mpremote.pyz ...` | Removes the pip step; only a Python is required. |

Selection rule: iterate in order, **probe each candidate fully**, pick the first that passes. While iterating, remember the first candidate that is a working Python >= 3.8 but lacks `mpremote` (`bestPythonWithoutMpremote`), because that is the install target for the one-click fix. If nothing passes, return a typed failure (8.7).

### 8.3 Validation (probe)

Run, with a clean environment and `windowsHide:true`:

```
<exe> <prefixArgs> -I -X utf8 -c "<PROBE>"
```

where PROBE prints one JSON line: `{"exe": sys.executable, "ver": [maj,min,mic], "venv": sys.prefix != sys.base_prefix, "mpremote": importlib.metadata.version("mpremote") or null}`. (Executed against the real venv: `{"exe": ".../mpy_test/.venv/bin/python", "ver": [3,13,13], "venv": true, "mpremote": "1.29.0"}`, ~110-130 ms warm. [E])

- Require Python >= 3.8, `mpremote` present, `mpremote >= 1.26` (README requirement; `mpremoteCommands.ts:51`); older -> distinct reason `mpremote-too-old` with an "Upgrade" fix.
- Timeouts: 20 s first probe of an executable, 8 s afterwards; one automatic retry on timeout; kill the process tree on timeout.
- Why `-I`: ignores `PYTHON*` env vars, user site-packages and the cwd/script dir on `sys.path` (shadowing protection; executed [E]).
- Probe output is parsed, never exit-code-only. Classify failures: `not-found` (ENOENT), `not-executable` (EACCES), `timeout`, `store-stub` (exit 9009 or "Microsoft Store" text), `macos-clt-shim` (xcode-select text), `module-missing` (stderr "No module named"), `python-too-old`, `bad-probe-output`, `blocked-by-policy` (Windows error text), `failed` (keep first stderr line). The prototype implements these and was exercised with fakes for store-stub, xcode shim, timeout, ENOENT, `py -3` as one string. [E]
- A second, real-command smoke test (`<launcher> -I -m mpremote version`, which does not touch serial ports; `--version` is an alias in mpremote 1.29) runs once per newly chosen launcher and its output is stored for diagnostics.

Environment for all spawns: copy of `process.env` with `PYTHONHOME`, `PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONINSPECT`, `PYTHONDEBUG`, `__PYVENV_LAUNCHER__`, `VIRTUAL_ENV`, `CONDA_PREFIX`-only-for-probes removed; add `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `PYTHONUNBUFFERED=1`, `PIP_DISABLE_PIP_VERSION_CHECK=1`, `PIP_NO_INPUT=1`.

### 8.4 How to invoke mpremote, and why `python -m` rather than the console script

Use `<python> -I -X utf8 -m mpremote <args>` for python-module launchers; run `mpremote.exe`/`mpremote` directly only for `console-script` launchers.

Why `-m`:

1. The interpreter that was validated is the interpreter that runs; no second PATH lookup.
2. Console scripts embed an absolute shebang (`#!~/src/mpy_test/.venv/bin/python3.13`, observed) or, on Windows, an absolute path baked into the `mpremote.exe` launcher; both break when a student renames/moves/copies the project folder. `python -m` through the venv's `python` is robust to the same move as long as the venv's own `pyvenv.cfg` still resolves.
3. Windows `Scripts\` is not on PATH unless activated; `bin/` likewise on macOS.
4. Works identically for `py -3` style launchers.
5. `mpremote/__main__.py` exists (observed in 1.29.0) so `-m` is supported.

Why `-I`: shadowing and env-poisoning protection (verified), and it is cheap.

Invocation surfaces:

- **Programmatic ops** (tree, cp, stat, reset...): `execFile(exe, [...prefixArgs, '-I','-X','utf8','-m','mpremote', ...args], {cwd: <extension storage or workspace>, env, windowsHide:true, timeout, maxBuffer})`. No `exec`, no string building. File paths with spaces/quotes are just array elements.
- **REPL / Run File terminals**: `createTerminal({name, shellPath: exe, shellArgs: [...prefixArgs,'-I','-m','mpremote','connect',port,'repl'], cwd, env})`. VS Code spawns the process directly: no login-shell PATH, no PowerShell parsing, no execution policy, no `sendText` race. To keep failure text visible, point `shellArgs` at a tiny launcher script shipped with the extension (`python/term_launch.py <mpremote args>`) that runs mpremote and, on non-zero exit, prints a friendly message and waits for Enter. (VS Code behaviour for a shellPath process exiting non-zero is not verified here [K]; the wrapper makes it independent of that.)
- Never `sendText` a command line into a user shell. If a human-visible command must be shown (install instructions), generate shell-specific quoting: POSIX `'...'`; PowerShell `& 'C:\...\python.exe' ...`; cmd `"..."`.

### 8.5 Caching and invalidation

- Key: `folderUri.toString()` or `"<none>"`. Value: `{state:'ok'|'failed', launcher?, failure?, fingerprint, resolvedAt}`.
- Single-flight: `Map<key, Promise<Resolution>>`; concurrent callers share one resolution. (Old code: 55 spawns for 5 callers. [E])
- **Positive** results live until invalidated (no 30 s TTL). Before each use do a free `fs.stat(launcher.exe)`; if missing -> invalidate.
- **Negative** results are never served to a user-initiated command (always re-probe, ~100 ms warm); for background callers, cache a failure for at most 3 s to avoid hammering during activation bursts.
- Fingerprint = hash of `{mpyWorkbench.pythonPath, mpyWorkbench.mpremotePath, python.defaultInterpreterPath, python-ext active env path, existence + mtime of candidate venv python and `pyvenv.cfg`, trust state, platform}`.
- Invalidate on (**list extended by Follow-up F.8**: also `python.useEnvironmentsExtension`, `python-envs.*` selection settings, `extensions.onDidChange`, `envs.onDidChangeEnvironment`/`onDidChangeEnvironments`, `python.environments.onDidChangeEnvironments`): `onDidChangeConfiguration` for `mpyWorkbench.*`, `python.defaultInterpreterPath`, `python.pythonPath`; Python-extension `environments.onDidChangeActiveEnvironmentPath`; `onDidChangeWorkspaceFolders`; `onDidGrantWorkspaceTrust`; window re-focus (cheap stat only, to notice a `pip install` done in a terminal); our own install flow; and **self-heal**: if an mpremote call fails with ENOENT, "No module named mpremote", or exit 9009, invalidate and retry once automatically.
- File watchers on `.venv` are deliberately avoided (large trees, default watcher excludes).

### 8.6 One-click fix for students (UX)

Entry points: status-bar item (`$(check) MicroPython: Python 3.13, mpremote 1.29` / `$(warning) Set up MicroPython tools`), the sidebar welcome view when unresolved (a button, not a toast), and the first failing user action (Run, REPL, Refresh).

Flow "Set up MicroPython tools" (`withProgress`, `ProgressLocation.Notification`, cancellable):

1. Choose the base Python: best from the resolution table (>= 3.8). None found -> OS-specific guidance (not a silent installer): Windows: "Install Python from python.org (tick *Add python.exe to PATH*) or run `winget install Python.Python.3.13`" with an "Open python.org" and "Copy command" button; macOS: python.org installer or `brew install python`. Re-check automatically on window focus.
2. Decide the target: if `folder` has a venv without mpremote -> install into it; else if `folder` exists -> create `folder/.venv`; else create the managed venv in `globalStorageUri`.
3. `python -m venv .venv` (execFile, cwd=folder, args array).
4. `<venv python> -m pip install --disable-pip-version-check --no-input "mpremote>=1.26,<2"`; if offline or the index is unreachable, retry with bundled wheels `--no-index --find-links <ext>/wheels` (classroom Wi-Fi).
5. Stream stdout to the "MPY Workbench" Output channel and map lines to progress messages ("Creating environment", "Downloading mpremote", "Installing", "Verifying").
6. Re-probe; show "Ready: Python 3.13.13, mpremote 1.29.0" plus, if the Python extension is installed and a different interpreter is selected, a one-time prompt "Select this environment for code completion?" (cross-reference: Pylance area).
7. No "restart VS Code" ever.

Error mapping (stderr substring -> message + action): `externally-managed-environment` (should not happen in a venv) -> use venv; `No module named venv` / `ensurepip` -> install full Python; `Permission denied` / `WinError 5` / OneDrive path -> "Use a folder outside OneDrive" or managed venv; `Could not find a version` / `Connection` / `SSL` / `proxy` -> offline wheels or "check network"; timeout -> "Antivirus may be scanning; retry".

### 8.7 Explaining failure

A typed `ResolutionFailure` with `code`: `NO_PYTHON`, `PYTHON_TOO_OLD`, `MPREMOTE_MISSING{python}`, `MPREMOTE_TOO_OLD`, `SETTING_INVALID{setting,value,expanded,reason}`, `UNTRUSTED_WORKSPACE`, `TIMEOUT`, `BLOCKED_BY_POLICY`, `STORE_STUB_ONLY`, `UNKNOWN{stderr}`; each carries the full candidate table. Messages in plain English: "Found Python 3.13 in `.venv`, but the `mpremote` package is not installed there. [Install mpremote] [Choose another Python] [Details]". Command `MPY Workbench: Show Environment Diagnostics` prints the table (candidate, expanded path, exists, ran, version, mpremote version, rejection reason, ms) and copies it to the clipboard for teacher support. The old code swallowed every reason into `console.log` (`pythonInterpreter.ts:49,66,83`).

### 8.8 Strategic option for "just works": ship mpremote

mpremote 1.29.0, pyserial 3.5 and platformdirs are pure Python (mpremote's `__main__.py` + wheel metadata observed in the venv). A `shiv`/`zipapp` `mpremote.pyz` (pinned, built in CI) can be run by **any** Python >= 3.8 with `python -I mpremote.pyz ...`, removing pip, PyPI and venv from the critical path; bundled wheels also enable offline `pip install`. Cost: rebuild on each mpremote release, a CI step, a firmware-compatibility pin to document. A step further, bundling a Python runtime per platform, is heavy (per-platform VSIX targets, unsigned binaries and SmartScreen/Defender friction on Windows) and not recommended initially.

### 8.9 Prototype evidence (executed)

`proto/resolver.js` (plain JS; vscode bits injected) implements 8.2 candidates 1, 2, 3 (injectable), 5, 6, the probe, and the classification. Results:

- **Real workspace `~/src/mpy_test`, `PATH=/usr/bin:/bin` (no global mpremote):** no settings -> chose `.venv/bin/python`, Python 3.13.13, mpremote 1.29.0 in 124 ms; with the user's literal `${workspaceFolder}/.venv/bin/python` -> same; relative `.venv/bin/python` -> same; typo'd setting -> `SETTING_INVALID`, no fall-through; no folder open or untrusted -> falls to system python3 (Xcode 3.9.6 here) and reports `MPREMOTE_MISSING` with the install target path.
- **Fixtures:** venv without module -> `MPREMOTE_MISSING` naming that exact venv python; macOS layout under `.../my proj/...` OK; **Windows layout** `.venv\Scripts\python.exe` found (platform forced to win32, fake exe) incl. `Jane Doe/OneDrive - School/lab1`.
- **Hostile candidates classified correctly:** Store stub (exit 9009) -> `store-stub`; xcode-select shim -> `macos-clt-shim`; hang -> `timeout` after 602 ms with a 600 ms limit; `"py -3"` as one string -> `not-found` (the old bug) while `{exe:'py', prefixArgs:['-3']}` is well-formed.

Limits of the prototype: no Python-extension integration, no real Windows execution, fixtures are shell scripts (so they prove layout/probe/classification logic, not Windows process semantics).

### 8.10 Test plan for the resolver

1. Pure unit tests with injected `fs`/`exec`/`platform`/`env` (as in the prototype): layout probing for both OS layouts, variable expansion table, ordering, explicit-setting-fails-hard, classification table, cache/fingerprint/invalidations, single-flight (N concurrent callers -> 1 resolution).
2. Fixture-interpreter tests (shell/batch scripts that emulate Store stub, hang, xcode shim, module-missing, too-old).
3. Real integration on CI `windows-latest` and `macos-latest`: create a venv in a path with spaces and a non-ASCII segment, `pip install mpremote`, run resolver + `python -I -m mpremote version`; plus a case with a student file named `serial.py` / `platformdirs.py` / `mpremote.py` in the project root.
4. `@vscode/test-electron` smoke: activate with and without Python extension, with `.venv`, with no folder, in restricted mode.
5. Manual matrix (teacher checklist): fresh Windows 11 (no Python; Store alias only), Windows with python.org install (PATH unticked), Windows with Store Python, macOS without CLT, macOS with Homebrew only, OneDrive-redirected Documents, Defender real-time on.

---

## 9. Requirements derived (for plan.md / CLAUDE.md)

See the structured output. Highlights: validate the candidate itself; launcher objects, no shell strings; both venv layouts; variable expansion; explicit-setting-is-authoritative; per-folder single-flight cache with invalidation + self-heal; `-I -X utf8`, clean env, `windowsHide`, process-tree kill; terminals via `shellPath/shellArgs`; Output-channel diagnostics + typed failures; one-click venv + pip install with progress and offline fallback; trust-aware; English UX; `.vscodeignore` must exclude `.venv/**`; activation events must include `onView`/`workspaceContains:**/{main,boot}.py` and not only `onLanguage:python`.

## 10. Open questions

1. Is bundling an `mpremote.pyz` (and offline wheels) acceptable to the user, and is there a specific mpremote version that matches the class firmware? (1.29.0 is what is installed in the test venv.)
2. Do students use managed/school-owned Windows laptops (AppLocker/WDAC, locked execution policy, no admin, OneDrive-redirected Documents)? That decides whether a `.venv` in the project folder is viable or the managed venv in `globalStorage` must be the default on Windows.
3. Should the project `.venv` remain the default (matches the teacher's current workflow and Pylance) or should the extension-managed venv be the default with the project `.venv` optional?
4. Which Windows Python distribution will students have (python.org with `py`, Store, or the new Python Install Manager)? Needs one clean-VM check per type.
5. Should the old `mpyWorkbench.*` settings be kept name-compatible in the new extension (the teacher's `.vscode/settings.json` files)?
6. The REPL terminal reliability hypotheses in 7.7 should be confirmed by the owner of the REPL area.

---

## Appendix A - shadowing / isolation experiment (executed, offline, no device access)

Interpreter: `~/src/mpy_test/.venv/bin/python` (3.13.13, mpremote 1.29.0). Scratch dir contains `platformdirs.py` = `raise RuntimeError("student file platformdirs.py shadowed the real module")`.

```
cd <scratch>/shadow && python -m mpremote version            -> RuntimeError: student file platformdirs.py shadowed the real module
cd <scratch>/shadow && python -I -m mpremote version         -> mpremote 1.29.0
cd <scratch>/shadow && .venv/bin/mpremote version            -> mpremote 1.29.0   (console script: sys.path[0] is the script dir)
PYTHONPATH=<scratch>/shadow python -m mpremote version       -> RuntimeError ... shadowed
PYTHONPATH=<scratch>/shadow python -I -m mpremote version    -> mpremote 1.29.0
python -I -X utf8 -m mpremote version                        -> mpremote 1.29.0   (0.36 s wall including interpreter start)
python -m mpremote --version                                 -> mpremote 1.29.0   (--version is an alias of the "version" command, main.py:425)
```

## Appendix B - file:line index of the resolution-relevant old code

- `src/pythonInterpreter.ts`: cache `:12-16,:25-28,:339-350`; Method 0 `:32-50`; Python-ext API `:113-153`; config `:170-194`; fallbacks `:199-224`; validation `:229-249` (global `mpremote --version` at `:235`); install prompt `:254-334`; dead helpers `:356-390`.
- `src/mpremote.ts`: `shellEscape` `:7-9`; exec options (no `windowsHide`) `:134-140`; `runMpremote` `:142-233` (resolution `:172-179`, command `:181`, `exec` `:184`); `listSerialPorts` message "available in PATH" `:872`.
- `src/mpremoteCommands.ts`: duplicate `shellEscape` `:8-10`; `buildMpremoteTerminalCommand` `:12-17`; restart REPL `:37-49`; startup check `:75-108` (Spanish strings `:82,91,103`); soft reset `exec` `:147-161`; `runActiveFile` `:164-227` (auto-port refusal `:169-173`, terminal `:219-226`); REPL terminal `:238-274` (`shellPath/shellArgs` `:254-258`, Ctrl-C/Ctrl-B timers `:260-271`).
- `src/extension.ts`: startup check `:38`; config-change cache clear `:890-893`; `withAutoSuspend` `:278-301`; `openRepl` `:871-874`.
- `src/pyraw.ts:12,15,18` (missing `thonny_list_files.py`), `src/monitor.ts:49-51` (dead).
- `package.json`: `activationEvents` `:24-26`; `capabilities.untrustedWorkspaces` `:14-18`; `mpyWorkbench.pythonPath` `:406-410`.
- `.vscodeignore` (no `.venv/**` rule), `.gitignore` (`*.py`).
- Installed-extension hand edit: `~/.vscode/extensions/danielbucam.mpy-workbench-0.3.2/dist/mpremoteCommands.js:50,246` (+ `.bak`, `.bak2`).

---

## Follow-up: Interpreter-resolution API ground truth with the Python Environments extension

Role: follow-up investigator for the gap listed in `10-completeness-critic.md` section 2.1 item 4 and section 9 item 9 ("Resolver ground truth with the Python Environments extension active"). Date of the experiments: 2026-10-12, macOS 14 (Darwin 24.6, x86_64). Nothing in `mpy-workbench` was touched, no serial port was opened, nothing was installed globally.

Extra evidence tag used here: **[L]** read from the user's own VS Code logs or state database (copied to the scratchpad first; read-only). **[E]** now means "observed in a real VS Code 1.141.0 extension host running the real, unmodified ms-python.python 2026.8.0 and ms-python.vscode-python-envs 1.38.0 bundles" (details in F.2), which is stronger than the hand-written `vscode` stub used in sections 4 and 8.

### F.0 Verdict

1. **Why the Envs extension owns discovery although `package.json` says `false`: an A/B-experiment assignment.** `python.useEnvironmentsExtension` is declared `default: false` with `tags: ["onExP", "preview"]` (`ms-python.python-2026.8.0/package.json:449-455`). VS Code's cached experiment payload on this Mac contains `config.python.useEnvironmentsExtension = True` (`~/Library/Application Support/Code/User/globalStorage/state.vscdb`, key `memento/experiment.service.memento`, `VSCode.ABExp.FeatureData.configs[0].Parameters`). The user's `settings.json` has no such entry. All 10 VS Code log sessions since 2026-09-23 show "Environment discovery is managed by the Python Environments extension". [L] Consequence: the setting is **an uncontrolled per-user, per-time input**; the students' value is unknown and can differ from the instructor's. The new extension must work in every regime of F.1.
2. **Which API returns the workspace `.venv`?** In the user's regime (Envs-managed, `.venv` present, nothing selected) every API *eventually* returns `<workspace>/.venv/bin/python`, but none is ready at activation time and they can disagree afterwards:
   - Python extension `environments.getActiveEnvironmentPath(folder)` (sync) returns the **bare string `"python"`** (`id: "DEFAULT_PYTHON"`) for the first 0.05-1.3 s in a quiet profile and for **~10-35 s on the user's machine** [E][L], then flips to the venv. `settings.getExecutionDetails` is identical and deprecated. Its official doc says "Returns the environment configured by user in settings. Note that this can be an invalid environment" (`@vscode/python-extension@1.0.6 out/main.d.ts`): it is a *settings/auto-select facade*, not a discovery result.
   - Envs `getEnvironment(folderUri)` is the engine that Python's own status/terminal code defers to in this regime, but it **caps its wait at 1 s and then returns the last-known value, `undefined` on a first call** (`vscode-python-envs-1.38.0/docs/README.md` "This call can return a stale value"; code at `dist/extension.js` offset 354383). The user's Python.log shows that happened in 4 of 5 `mpy_test` sessions ("No Python environment is set for this resource", 9.8-16.8 s after host start). [L]
   - `python.defaultInterpreterPath` is **`""` in the user's User settings**, so it contributes nothing; and `vscode.workspace.getConfiguration().get()` returns it **unexpanded** (`${workspaceFolder}/...` literally) [E]. This turns the previous [K] in section 4.1 into [E].
3. **None of the APIs should be the primary resolver input.** The only source that was right at t=0 in all regimes was the deterministic local-venv probe (candidate #2). API answers are *hints* that must (a) race a short timeout, (b) reject bare names and non-existent paths, (c) go through the same probe as every other candidate, and (d) be re-evaluated on events using the event payload. Revised candidate #3 text: F.7. Revised invalidation list: F.8.
4. **The critic's concern is right in direction, wrong in mechanism.** It is not that the Python extension's API returns nothing in Envs mode: it keeps working as a facade. The failure modes that would reproduce complaint 1a are (i) trusting the transient `"python"`, (ii) trusting `undefined` as "no environment", (iii) trusting a non-existent path from a typo'd `defaultInterpreterPath`, and (iv) the two APIs disagreeing after a global interpreter was chosen (F.5). Each was reproduced.
5. **Untrusted workspace: neither API exists.** `getExtension('ms-python.python')` and `getExtension('ms-python.vscode-python-envs')` both return `undefined` when the workspace is untrusted (both manifests say `untrustedWorkspaces.supported: false`). [E] Section 5's note that `resolveEnvironment` "throws ... in an untrusted workspace" is true of the bundle but unobservable by a third-party extension.

Confidence: high [E] for macOS/VS Code 1.141.0/these two extension versions; high [L] for the ExP cause; medium for Windows (same JS, different PET binary and shells; not executed); low for what the students' ExP assignment is (unknowable from here).

### F.1 The regimes the new extension can find itself in

Two independent gates exist in the Python extension bundle (`ms-python.python-2026.8.0/out/client/extension.js`, minified; byte offsets given):

- `useEnvExtension()` (def. at ~465,200): `getExtension("ms-python.vscode-python-envs") && getConfiguration("python").get("useEnvironmentsExtension", false)`, **cached for the whole session** in module variable `u`. Routes interpreter discovery (`createEnvExtApi`, ~822,947), the active interpreter (`resolveActiveInterpreter -> getActiveInterpreterLegacy`, ~568,698), terminals, debug, package install. The "Environment discovery is managed by ..." log line is emitted the first time `getEnvExtApi()` runs (~465,829).
- `shouldEnvExtHandleActivation()` (def. at ~465,090): Envs installed **and** the setting is not explicitly `false` at user/workspace/folder level. When true the Python extension hides its own status-bar item (~552,370/553,713) and stops activating terminals (~294,098, ~617,863, ~891,077); the Envs extension does that instead (`python-envs.terminal.autoActivationType` default `"command"`, `package.json` of Envs; it types `source .../activate` into every new terminal, which is the "Send text to terminal" mechanism in critic 2.1 item 2).

Combined with Envs' own opt-out (`dist/extension.js` offset ~976,790: `activate()` returns without exports when the setting is explicitly `false`):

| Regime | `python.useEnvironmentsExtension` | Envs ext | Who discovers | Verified how |
|---|---|---|---|---|
| **R1** (the user, via ExP) | effective `true` | active at Python-ext activation, exports present | Envs (PET) | [E] scenarios P1/Q1/T1; user logs [L] |
| **R2** (students with no ExP hit, Envs installed) | unset => `false` | **not active** until a `.py` is opened (`onLanguage:python`, Envs `package.json:29`) or someone calls `activate()`; exports present once active | Python ext native locator, but Envs already owns status bar + terminal activation | [E] P2/A1 (probe activated Envs by hand) |
| **R3** (explicit opt-out) | explicit `false` | `activate()` resolves with `exports === undefined` | Python ext native locator | [E] P3/D1b |
| **R0** | n/a | not installed (Python ext's `extensionPack` lists it, `package.json:1817`, so only if the student removed/disabled it) | Python ext native locator | [E] H1 |
| **Untrusted** | n/a | both extensions absent from the host | nobody | [E] E1/E2 |

The experiment value can change between sessions without the user doing anything, and `useEnvExtension()` is cached per session, so **capability must be detected per call, never inferred from the setting**.

### F.2 Method (what was executed)

- Real VS Code 1.141.0 (`/Applications/Visual Studio Code.app`), launched as separate processes with throw-away `--user-data-dir` profiles and `--extensions-dir` copies of exactly the three installed extensions (python 2026.8.0, python-envs 1.38.0, debugpy 2026.6.0; Pylance omitted and `python.languageServer: "None"` so no language server competes). The user's own VS Code windows were not touched.
- A development extension (`--extensionDevelopmentPath`) activates on `onStartupFinished`, calls `ms-python.python`'s `activate()`, and then runs independent samplers: a 20 ms synchronous sampler of `environments.getActiveEnvironmentPath(folder)`; 100 ms of `settings.getExecutionDetails`; looping `environments.resolveEnvironment(getActiveEnvironmentPath(folder))` with latency; looping Envs `getEnvironment(folder)` with latency; and listeners for `onDidChangeActiveEnvironmentPath` / `onDidChangeEnvironment` that also re-read the sync getter *inside* the handler. Only changes are logged (JSON lines).
- Workspaces: `ws/.venv` and `ws3/.venv` (fresh Homebrew 3.13.13 venvs), `ws2/venv` (non-dot name). Settings mirrored the user: User `python.defaultInterpreterPath: ""`, `terminal.integrated.inheritEnv: false`. Telemetry and `workbench.enableExperiments` off, so R1 was forced with an explicit `true` (equal to what `getConfiguration().get()` returns under the ExP assignment: the bundle reads it with that exact call).
- ~35 launches in total. Harness and raw logs (scratchpad): `.../scratchpad/envapi/{run_scn.py,summ2.py,dev-ext2/extension.js,out/*.jsonl}`. Re-run: copy the three extension dirs from `~/.vscode/extensions` into `envapi/exts`, `python3 run_scn.py <name> <workspace> --use-envs true|false|unset [--trust on] [--select envs|pyext|pyext-other|envs-other] [--dip VALUE]`, then `python3 summ2.py <name>`.
- Limits: macOS only; quiet profile (discovery finished in 0.1-1.3 s, unlike the user's 10-35 s, so the Envs 1 s timeout was **not** reproduced in the probe; it is evidenced only by the user's logs and the bundle); no ExP fetch; Windows not run.

### F.3 What each API returns (executed)

`t` is ms after the probe started, with the Python extension already active (`workspaceContains:.venv` fired). "venv" = the workspace `.venv/bin/python`.

| API | Immediately after Python-ext activation | Steady state | Notes |
|---|---|---|---|
| `python.environments.getActiveEnvironmentPath(folder)` (sync) | `{id:"DEFAULT_PYTHON", path:"python"}` in **R0, R1, R2, R3** (P1 t=52, P2 200, P3 97, H1 30) | venv at t=380 / 627 / 513 / 612 (quiet); 10-35 s on the user's machine [L] | In R1 the first event fires *before* the getter flips: reading the getter inside the first `onDidChangeActiveEnvironmentPath` handler still returned `"python"` (Q1: event t=218, getter flips t=276). Use the event's `path`. |
| `settings.getExecutionDetails(folder).execCommand` (deprecated) | `["python"]` | `[venv]` 50-130 ms after the getter | Same readiness as the getter. Do not use. |
| `python.environments.resolveEnvironment(getActiveEnvironmentPath(folder))` | with the bare `"python"`: **blocks until discovery completes** (199-1127 ms here) then returns the full venv record (`executable.uri` defined) | with an absolute path: 0-30 ms | Contradicts the earlier note that it returns `executable.uri === undefined` for a bare `python`: in every run that passed the bare name (13 probe-v2 scenarios plus the 7 first-generation runs) it was resolved to the venv. The blocking is unbounded in principle. A non-existent path returns `undefined` (F5). |
| Envs `getEnvironment(folder)` | **R1:** venv at t=52-626 (never `undefined` in the probe because discovery was < 1 s). **R2:** exports exist only after `activate()`; venv at 503-1640. **R3/R0:** no API (`exports === undefined` / ext absent) | venv | Documented 1 s race + last-known fallback (`undefined` on first call). [L] shows the falsy case in 4 of 5 real sessions. |
| `python.defaultInterpreterPath` via `getConfiguration().get` | the user's value is `""`; package default `"python"` | unchanged | Returned **unexpanded**: `${workspaceFolder}/.venv/bin/python` stays literal [E]. |
| ... but the Python/Envs APIs given a `defaultInterpreterPath` | `${workspaceFolder}/.venv/bin/python` or relative `.venv/bin/python`: the **sync getter returns the expanded absolute venv at once** (F1 t=41, F3 t=40, R3: 95-116) and Envs reports `source: defaultInterpreterPath` first, then `.venv` | | Both extensions expand `${workspaceFolder}` and relative paths themselves (Envs `resolveVariables`, webpack module 4500 in `dist/extension.js`: `${workspaceFolder}`, `${workspaceFolder:name}`, `${userHome}`, `${env:X}`, `${cwd}`, `${pythonProject}`). |
| With a **persisted selection** (restart after `setEnvironment` or `updateActiveEnvironmentPath`) | all four sources return the venv at the first sample, 2-30 ms after the probe started (B2r t=51, B3r t=57) | | "With the `.venv` selected" has **no race**. |
| Untrusted workspace | `getExtension(...)` is `undefined` for both extensions; `python.*` defaults are not even registered (raw `get` returns only user-written values) | | E1 (setting `true`), E2 (unset). |
| Non-dot venv name (`venv/`) | found by Envs (G1, t=626) and by the native locator (G2, t=1104) | | Do not hard-code only `.venv` in the API path. Our own probe (candidate #2) does check `venv`, `env`. |

Cost of `await pyExt.activate()` when the Python extension is not yet active (workspace without a `.venv` folder, G1/G2): 260-340 ms. In the user's logs the Python extension activated 0.2-7 s after host start (17.8 s and 21.8 s in two windows that opened while several others were starting).

### F.4 Timing and activation races (the user's real machine, [L])

From `Code/logs/20261012T114536` (`exthost.log`, `Python.log`, `Python Environments.log`), seconds after extension-host start, the five `mpy_test` sessions with `.venv` and no persisted selection:

| Session | Python ext activated | Envs "No Python environment is set" (= `getEnvironment` returned falsy) | Envs `Changed environment ... to .venv` | Python.log `Active interpreter [mpy_test]: .../.venv/bin/python` |
|---|---|---|---|---|
| w2 11:48:02 | 6.9 | - | 21.4 | 26.7 |
| w3 12:11:51 | 0.9 | 11.8 | 23.6 | 26.5 |
| w3 12:28:03 | 1.7 | 15.4 | 32.3 | 35.2 |
| w4 12:34:05 | 0.3 | 16.8 | 22.6 | 24.2 |
| w5 12:37:38 | 0.3 | 9.8 | 10.2 | 18.4 |

The nine earlier ME241 (OneDrive) sessions show 4.1-10.5 s to the first Envs selection. In `w3 12:11:51` the venv was already "Discovered" at 12:12:01.39 (0.3 s after the Envs extension started logging) but the selection was published at 12:12:15.15, 13.8 s later, right after the whole PET refresh finished (matches `docs/startup-flow.md`: no persisted selection => slow path => `initialize()` => full refresh). The Envs extension's own first log line came 7.5 s after the host activated it (activation 12:11:53.5 vs first log 12:12:01.05), so part of the delay precedes discovery. Why the same refresh takes 0.3 s in the clean profile and 14 s here is **unexplained** [U]; candidates are machine load from several windows starting at once, anaconda/pyenv probing (`conda info --json`, `pyenv which python` are in the log), and OneDrive-hydrated paths. Treat the window as "up to tens of seconds" and design for it; a student laptop with Defender on Windows can plausibly be no better [K].

Event/ordering facts from the probe ([E], quiet machine):

1. Sync getter lags the Envs-driven event by 45-70 ms in R1 (read inside the handler => still `"python"`); in R0/R2/R3 getter and event flip within +-3 ms of each other (P2: getter 627, event 630; P3: 513/515; H1: event 611, getter 612).
2. A start-up produces 1-3 `onDidChangeActiveEnvironmentPath` events (one with `resource`, one without) and 2 `onDidChangeEnvironment` events (the folder, then `global`); an identical old/new pair can also fire after a restart (B3r). **Last event wins is not safe** (F5 case a: venv first, typo path last).
3. `pyExt.activate()` resolves before discovery finishes (0-1 ms when already active). There is no "ready" promise: `exports.ready` exists in the Python extension's export list but was not used by the old code and was not evaluated here [U].

### F.5 Disagreement and failure cases that would reproduce "venv not found" ([E])

a. **Typo'd/stale `python.defaultInterpreterPath`** (F5: `${workspaceFolder}/.venvv/bin/python`): Python getter and `getExecutionDetails` return the **non-existent** `.../.venvv/bin/python` for the whole 20 s run; `resolveEnvironment` -> `undefined`; the event stream goes venv (t=63) then typo path (t=139); Envs `getEnvironment` quietly falls back to the real `.venv`. A resolver trusting the Python getter without `fs.stat` fails; one trusting Envs succeeds.
b. **Envs persisted a global interpreter** (J1, and by accident X1/X2): after `setEnvironment(folder, python3.12)` Envs wrote `"python-envs.defaultEnvManager": "ms-python.python:system"` **into the workspace `.vscode/settings.json`**. Every later session then selected system Python 3.15 for that folder (`source: defaultEnvManager`) although `.venv` existed. In that state Envs `getEnvironment` said system Python for the whole 70 s, while the Python getter said `.venv`, and the Python event stream emitted both values. (The Envs UI most likely uses the same call, so a student's earlier "pick the global interpreter" click would persist in a file that gets zipped or committed with the project; not tested through the UI.)
c. **Selection APIs do not propagate in R1.** After Envs `setEnvironment(python3.12)` the Python getter stayed on the venv and fired no event for 5 s (J1). After Python `updateActiveEnvironmentPath('/usr/local/bin/python3.12')` the Python getter switched at once but Envs `getEnvironment` stayed on the venv, also after a restart (U1, U1r: events show venv then 3.12). The Python picker command calls both (`updatePythonPath` + `setInterpreterLegacy`, bundle ~536,682); the public API call does only the first. To align selection programmatically, call both.
d. **Trusting `undefined` from Envs** as "no environment": see [L] 4 of 5 sessions.
e. **Trusting the first non-empty answer.** In every clean R1 run the first non-`undefined` Envs answer was already the venv, so a *transient wrong interpreter* was **not** observed without a poisoned setting. Not claiming it.

### F.6 Corrections to earlier statements (explicit)

- **01 section 5, "Python extension API" bullet** ("`python.useEnvironmentsExtension` (default `false`) can route to the separate Python Environments extension"): for this user the effective value is `true` through ExP; the Envs extension is primary, not secondary. 10 section 2.1 item 4 is confirmed and now explained.
- **01 section 5**, "`resolveEnvironment` ... `executable.uri` ... `undefined` when the executable is the bare name `python`": **not reproduced**; with the bare name it blocked and then returned a defined URI in all tested regimes. It can only be `undefined` if the bare name cannot be turned into a full path (not tested, e.g. no interpreter at all).
- **01 section 5**, "`resolveEnvironment` throws ... in an untrusted workspace": true in the bundle, never observable (extension absent).
- **01 section 4.1** [K] "`getConfiguration().get()` does no variable substitution": now [E] with the real host (F.3, `defaultInterpreterPath` row).
- **01 section 8.2 candidate #3** (old text): the fallbacks "`python.defaultInterpreterPath` (expanded)" is `""` for this user; "deprecated `settings.getExecutionDetails`" has the same readiness as the getter; "if Envs is active use its `getEnvironment(uri)`" omitted the 1 s race, `exports === undefined` under explicit `false`, and the selection divergence. Replaced by F.7. The old `pythonInterpreter.ts:113-153` Method 1 (`getExecutionDetails(uri).execCommand[0]`) would therefore have returned the bare `"python"` for the first ~10-35 s of every window on this machine (consistent with S6 in section 4.3), but that code path was **not** what the user ran (section 1), so this is not the cause of complaint 1a.
- **01 section 8.5 invalidation list**: incomplete; replaced by F.8.
- The fix-vs-rewrite decision is unaffected: this is resolver design, equally applicable to either path.

### F.7 Replacement for section 8.2, candidate #3

Position in the ordered list is unchanged (1 explicit `mpyWorkbench.pythonPath`, 2 local venv probe, **3 Python-tooling hint**, 4 managed venv, ...). Rationale for keeping the local probe first: it was correct at t=0 in all regimes; the APIs were wrong or unavailable for 0.05-35 s, can diverge from each other, and cannot tell "explicitly selected" from "auto-discovered". Known cost: an interpreter the student explicitly picked in the UI does not outrank a `.venv` in the folder; show the chosen interpreter and its source in the status item and in `Show Environment Diagnostics`, and offer the explicit `mpyWorkbench.pythonPath` override.

Candidate #3, in order, each only a *source of candidate paths* that is then probed like any other (reasons recorded):

1. Skip with reason `untrusted` when `!workspace.isTrusted`.
2. **3a, explicit setting hint:** `getConfiguration("python", folder).inspect("defaultInterpreterPath")`, effective value among `workspaceFolderValue ?? workspaceValue ?? globalValue`; ignore `""` and `"python"`; expand `${workspaceFolder}`, `${workspaceFolder:name}`, `${userHome}`, `${env:X}`, `~`, relative-to-folder ourselves; `fs.stat` it.
3. **3b, Envs API (R1/R2 only):** `ext = getExtension("ms-python.vscode-python-envs")`; if present, `await ext.activate()` (may resolve with `exports === undefined` under explicit `false`: then skip silently); `Promise.race([api.getEnvironment(folderUri), sleep(1500)])`; `undefined`/timeout => "not ready", **not** "none"; use `env.execInfo.run.executable` (string) else `env.environmentPath.fsPath` (may be the env folder: map to its interpreter); `fs.stat`.
4. **3c, Python extension API (R0-R3):** `getExtension("ms-python.python")`; if present `await activate()` raced with 3 s; `p = api.environments.getActiveEnvironmentPath(folderUri).path`; reject if `id === "DEFAULT_PYTHON"`, a bare name, not absolute, or missing on disk (case F5a). Optionally `resolveEnvironment({path: p})` raced with 3 s **only** to read `version`/`sysPrefix`; never rely on it to turn a bare name into a path (unbounded block). Do not call `settings.getExecutionDetails`.
5. If 3b and 3c both yield paths and differ, record "Python tooling disagrees" in diagnostics; prefer 3b when the Envs extension is active (it owns the visible selector and terminal activation, F.1), else 3c.
6. Never block a user command on 3a-3c; if none is ready, continue to candidate #4/#5/#6 and re-resolve when the events of F.8 fire.
7. Detect capability **per call** (`getExtension`, `exports !== undefined`), never from `python.useEnvironmentsExtension`.

When our one-click fix creates or repairs a `.venv`, optionally (with consent) align Python tooling so Pylance/terminals use the same environment: call `envsApi.resolveEnvironment(Uri.file(venvPython))` + `envsApi.setEnvironment(folderUri, env)` when Envs exports exist, **and** `python.environments.updateActiveEnvironmentPath(venvPython, folderUri)` (F.5c: the two stores are independent). Selecting the folder's own `.venv` through Envs `setEnvironment` created no `.vscode/` folder on a fresh workspace (V1, `ws4`), nor did Python `updateActiveEnvironmentPath` (U1, `ws3`); selecting an interpreter of a *different manager* via Envs does write `python-envs.defaultEnvManager` (F.5b), so only ever select the folder's own `.venv`.

### F.8 Replacement for the section 8.5 invalidation list

Re-resolve (drop the cached launcher for the affected folder, re-run the probe lazily, never serve a cached negative to a user command) on:

- `workspace.onDidChangeConfiguration` for: `mpyWorkbench.*`, `python.defaultInterpreterPath`, `python.pythonPath`, `python.useEnvironmentsExtension` (needs a window reload to take effect in the Python extension, but the capability set changes), `python-envs.defaultEnvManager`, `python-envs.pythonProjects`, `python-envs.workspaceSearchPaths`, `python-envs.globalSearchPaths`. Note Envs itself writes `.vscode/settings.json` when a different manager is chosen (F.5b), so this also fires for edits we did not make.
- `extensions.onDidChange` (Python/Envs installed, uninstalled, enabled, disabled; also how an untrusted workspace gains the extensions once trust is granted [K: not exercised]).
- `workspace.onDidGrantWorkspaceTrust`, `onDidChangeWorkspaceFolders`.
- `pythonApi.environments.onDidChangeActiveEnvironmentPath` (per resource; may fire 2-4 times at start; debounce ~250 ms; use the event `path`, not the getter, for the first event; always re-probe and validate existence, because the last event can be a non-existent typo path).
- `envsApi.onDidChangeEnvironment` (scope `e.uri`; `undefined` = global; can fire with identical old/new) and `envsApi.onDidChangeEnvironments` / `pythonApi.environments.onDidChangeEnvironments` (an environment appeared or vanished, e.g. our fix just created `.venv`).
- Window re-focus (cheap `stat` of the cached launcher), our own install/repair flow, and the self-heal rule (ENOENT / "No module named mpremote" / 9009 => invalidate and retry once), unchanged from section 8.5.
- Do not subscribe to file watchers on `.venv` (unchanged).

### F.9 Windows and other-platform status ([K]/[R], not executed)

The two extension bundles are platform-independent JavaScript; only the PET binary (`python-env-tools/bin/pet`, `pet.exe` in the win32 build) and shells differ. Expected deltas to check on a Windows VM: layout `.venv\Scripts\python.exe` (compare paths case-insensitively and slash-normalised before treating two APIs' answers as "different"), PET discovery of the Microsoft Store alias and `py` launcher registry entries (could surface a Store-stub interpreter as the "selected" one before `.venv` wins), Defender latency lengthening the F.4 window, and OneDrive-redirected `Documents`. The `${workspaceFolder}/.venv/bin/python` form of `defaultInterpreterPath` that works on macOS is wrong on Windows (needs `Scripts\python.exe`), so a course template cannot share one value across the two OSes; the local probe has no such problem.

### F.10 Open items and how to close them

1. Reproduce the Envs 1 s timeout (`getEnvironment` -> `undefined` on the first call) in a controlled way. A deliberately slow PATH interpreter (7 s wrapper) did **not** delay `.venv` selection (T1: venv at t=78), so the delay on the user's machine comes from something else. Close by recording a `Python Environments.log` with trace logging on the user's machine, or by profiling PET with `RUST_LOG` while reopening `mpy_test`.
2. The students' ExP state and whether the Envs extension is installed/active: ask three students for `Developer: Show Running Extensions` and `python.useEnvironmentsExtension` (`Preferences: Open Settings (JSON)` plus the first lines of the Python output channel).
3. Windows run of the same probe (harness is OS-neutral apart from `venvPython`, the `Code` path and the short-socket-path workaround) in the existing Windows 10 VM.
4. `exports.ready` of the Python extension and `onDidChangeEnvironments` completeness events as a better readiness signal than a timeout [U].
5. Granting trust at runtime: do the two extensions appear without a host restart? [K]
6. Whether Pylance follows the Python getter or the Envs selection in R1 (affects "same interpreter for linting and mpremote"); relevant to `07-linting-stubs.md`.

### F.11 Side effects of this investigation (for the record)

About 35 isolated VS Code windows were opened and closed on this Mac under `--user-data-dir` profiles in the scratchpad (a short symlink `<short temp link>` was needed because macOS limits the IPC socket path to 103 characters). For about two minutes 16 busy-loop Python processes were run to emulate load; they were killed afterwards (load average peaked at 146 and decayed). The user's own VS Code windows, settings and extension directories were only read. `mpy-workbench` and `~/src/mpy_test` were not modified.
