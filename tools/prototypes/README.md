# Prototypes (read-only provenance)

Tested prototypes written by the analysis agents on 2026-10-12 (see `docs/analysis/09-architecture-options.md` appendices A-C and `07-linting-stubs.md` section 12). They are **references**: copy ideas, not files; the maintained versions live in `bridge/`, `tools/fakeboard.py`, `src/intellisense/`. Do not edit the `*_v0.*` files.

- `fakeboard_v0.py` - TCP fake board (stdlib only; 416 lines): friendly/raw REPL, raw paste, boot.py/main.py semantics, `--exclusive`, `--log`
- `bridge_proto_v0.py`, `drive_bridge_v0.py` - architecture-C proof of concept built on vendored mpremote's `SerialTransport`
- `mpunix_relay_v0.py` - TCP <-> pty relay for the real MicroPython unix port
- `mpy_intellisense_v0.mjs`, `manifest_probe_v0.py`, `device_introspect_v0.py` - IntelliSense generator prototypes (R5)
