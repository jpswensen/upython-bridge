# Demo project for the Marketplace screenshots

Made-up material for `tools/vscode_test/screenshots.py` (no real course or board names): a line-following robot project
(`project/`) and a fake board (`board/`) whose firmware has a custom library `rover` (frozen Python package) and `_rover`
(a "C" module, emulated in Python by tools/fakeboard.py). The board starts with an unset clock (year 2000), a `boot.py` and a
`data.csv` that an earlier run wrote, and the same `calibration.json` as the project.
