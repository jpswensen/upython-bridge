# Board-specific and course-specific material (to be extracted before public release)

Instructor, 2026-10-12: "We will eventually take our board-specific stuff out of this project before releasing to the world (and only the board-specific firmware will be distributed to students)." Companion to D-15 (firmware generality).

**Rule:** shipping code (`bridge/`, `src/`, `tools/fakeboard.py`, `tools/mpunix_relay.py`, `tools/hwtest/`) and generic tests never depend on the WSU_SHIELD firmware, its `shield`/`_shield` modules, course names (ME241/ME401) or motor-shield hardware facts. Firmware/course knowledge is data in an optional `profile.json`. Where such material must exist it lives in `private/wsu/**` or `examples/profiles/wsu_shield/**`, both stripped from a release.

**Tool:** `python3 tools/check_generic.py` (report) / `--strict` (fails if a must-be-generic file still mentions specifics). Run it before every release candidate; re-run after each round to keep the inventory honest.

## Inventory (2026-10-12, report mode)

| Where | Mentions | What it is | Extraction plan |
|---|---|---|---|
| `tests/test_devfs.py` | ~80 | `shield`/`_shield` used as the example frozen module in shadow-guard and identity tests | rename to a generic module (`acme`, `_acme`); keep WSU-named cases (if any are wanted) under `private/wsu/tests/` |
| `tests/test_scenarios.py`, `tests/bridge_client.py`, `tests/adversarial/*`, `tests/test_link.py`, `tests/test_fakeboard.py` | ~38 | shadow-guard paths (`/shield.py`), OneDrive/ME 241 path fixtures, WSU profile examples | generic names; the OneDrive-style fixture stays but without the course name |
| `bridge/devfs.py` | 8 | docstring examples naming `shield` | reword to `acme` |
| `tools/hwkit/` | ~40 + reports | the WSU_SHIELD hardware kit (checks `_shield`, `WSU_SHIELD`, GPIO15 motor facts) and the session-1 reports | move to `private/wsu/hwkit/`; the generic harness is `tools/hwtest/` (config-driven) |
| `docs/analysis/**`, `docs/old-defects.md`, `docs/requirements.md`, `docs/decisions.md`, `docs/spikes-and-questions.md`, `CLAUDE.md`, `plan.md` | many | internal planning/evidence | not shipped (release excludes them); public docs are written fresh |
| WSU profile and course stub pack (not yet created) | - | `profile.json` (accepted `_build`, frozen modules, `resetWarning`), `course-stubs/` | create directly under `examples/profiles/wsu_shield/` |

## What stays generic by design
Stock stub selection, firmware-source discovery (manifest evaluation, C-module scanner), identity probe, reset tiers and their `resetWarning` text (profile-supplied, generic default), shadow guard (module names come from profile + board inventory), fake-board profiles (the "custom-frozen" profile is a generic stand-in).
