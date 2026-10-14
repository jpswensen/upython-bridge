# tools/vscode_test - extension-host tests in a real, isolated VS Code

CLAUDE.md ("VS Code / Electron launches") is the policy; `launch.py` is the only vetted way to start VS Code.

    python3.13 -B tools/vscode_test/launch.py --suite smoke|activation|views|flow|all|python|coexist|exitprobe|intellisense|intellisense-spikes|intellisense-all [--timeout 180]
    (the intellisense suites force --with-python-extensions: real Pylance on a made-up firmware project written by the launcher from test/fixtures/intellisense; npm run test:vscode:intellisense | test:vscode:intellisense-spikes)
        [--with-python-extensions] [--with-old-extension] [--activate-via view|command] [--quit-via command|test-exit]
        [--markers] [--keep-run-dir] [--bridge-stderr-log] [--bridge-trace] [--dry-run] [--extra-arg=--disable-gpu]
    npm run test:vscode | test:vscode:smoke | test:vscode:python | test:vscode:coexist     (build, then launch)

Wrap a launch in `timeout 330`. One instance at a time (the launcher refuses while a scratch process exists). `--dry-run` builds
the scratch folder and the fake board, prints the command and does not start VS Code.

- Scratch root `/tmp/mpyvs/<suite>-<HHMMSS>/` {portable/user-data, ext, ws, out, board}, removed afterwards. `VSCODE_PORTABLE` points at
  `portable/` because VS Code rewrites `~/.vscode/argv.json` at every start otherwise (seen in the first run). In portable mode VS Code
  IGNORES `--user-data-dir` and uses `portable/user-data`; the launcher passes the same path anyway.
- A fake board (`tools/fakeboard.py`, `socket://127.0.0.1:PORT`) runs inside the launcher; the workspace settings name it with the
  documented `upy-bridge.port` setting. `MPY_SAFE_MODE=1` is set, `MPY_REAL_PORT` never.
- The in-host runner (`test/vscode`, bundled to `out/vscode-tests/index.js`) writes `results.json`. The extension's test hook
  (`src/testApi.ts`, only when `UPYBRIDGE_TEST=1`) gives read-only access to session state, the Files view, what the terminal shows and
  receives, and the status bar texts. The launcher then reads the extension-host log and looks for surviving processes.
- `--quit-via command` (default) ends the window with `workbench.action.quit`, as a student does. `test-exit` lets `run()` return,
  which is VS Code's test-mode exit: it kills the extension host's children abruptly (the bridge never reaches its shutdown
  sequence), so never use it to judge what happens when a window closes.
- `--bridge-trace` runs the bridge through a small shell wrapper that also logs how the Python bridge ended (`python ended with
  status N`, 128+n = killed by signal n) to `bridge-trace.log`. After `--quit-via command` it says status 0; after `test-exit` the
  line is missing because the wrapper itself was killed too (2026-10-13). `--suite exitprobe` starts two plain shell helpers from the
  extension host and records in `child-trace.log` whether they see the end of their stdin and survive VS Code's exit.
- `--quit-via test-exit` is expected to end with exit code 1 on `flow`: the check "no program is left running on the board" fails.
  That is an open, unexplained difference to a normal close, see DEVELOPING.md ("Closing the window").
- VS Code itself exits with code 1 after `workbench.action.quit` in test mode; the verdict comes from results.json and the checks.
- Exit codes of the launcher: 0 all passed, 1 test or check failures, 2 hard timeout / blocked, 3 harness error.
- Evidence per run in `reports/<id>/`: results.json, summary.json (argv, process checks, real-profile diff, real-port lsof), logs/,
  fakeboard-events.json, ps-timeline.json (process tree sampled every 50 ms), vscode-stdout-stderr.log.
