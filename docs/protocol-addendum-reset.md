# Protocol addendum A1: reset capabilities and the "Reset board..." action

Status: **designed 2026-10-12, not yet implemented.** The R1 workflow was already running against `protocol.md` v1 when this was decided; merge this into `protocol.md` (as v1.1) and implement it in a short follow-up step ("R1.5") once the R1 workflow has finished. Decision: D-16 (`decisions.md`). Requirements: RQ-RESET-1..6 (`requirements.md`). Origin: the instructor's suggestion after hardware session 1 showed that forcing the control lines resets this board (V2/V3: 4 of 4).

## 1. Why three tiers

| Tier | What it does | Needs control lines? | Needs a responsive REPL? | Typical use |
|---|---|---|---|---|
| **soft** (`reset.soft`) | Ctrl-D at the friendly prompt: new Python VM, `boot.py` then `main.py`; chip not reset | no | yes | "restart my program" |
| **machine** (`reset.machine`, new) | `machine.reset()` sent through the REPL: real chip reset (re-runs firmware init, `boot.py`, `main.py`); native-USB boards drop and re-enumerate their port | **no** | yes | "reboot the board" on any board, no wiring assumptions |
| **hard** (`reset.hard`) | Pulse the control lines (esptool-style RTS pulse, DTR low) so EN is toggled; works on a hung board | **yes** (auto-reset wiring) | **no** | rescue when Stop does not work (program ignores Ctrl-C, `kbd_intr` disabled) |

Every tier above `soft` is explicit, never implicit or automatic (RQ-SAFE-2), requires `confirmed:true`, and the UI shows the firmware profile's `resetWarning` (generic default: "A reset restarts the board and may move connected hardware").

## 2. Capability model

`reset.capability` -> `{"soft": true, "machine": {"available": bool, "reason": str}, "hard": {"state": "verified"|"likely"|"unknown"|"unlikely"|"failed", "method": "rts-pulse"|"usb-jtag"|"none", "reason": str, "basis": "learned"|"adapter"|"transport"}}` (cached for the session; recomputed on connect).

**`machine`**: available when the board is connected, state is `idle` or `running` (a running program is interrupted first, with the usual consent), and `identity` showed a REPL that accepts `import machine` (capture in `identity.caps.machine`). Not available on URL/test transports unless the fake board supports it.

**`hard.state` is estimated, then learned** (it cannot be known for certain without pulsing the line, because whether a given PCB has the auto-reset transistors is invisible over USB):

1. *learned* (wins over everything): a record in extension storage keyed by (VID, PID, `machine.unique_id()`; for URL transports no record) written by a successful or failed **verification** (section 3). `verified` or `failed`.
2. *adapter* estimate from `ports.list` metadata and the identity platform (all [K]/[U] until measured; extend the table as hardware sessions add evidence):
   | Adapter (VID:PID) | Platform in `identity` | Estimate | Method |
   |---|---|---|---|
   | CP210x 10C4:EA60, CH340 1A86:7523, CH9102 1A86:55D4, CH343 1A86:55D3, FTDI 0403:6001/6010/6015 | `esp32`, `esp8266` | `likely` | `rts-pulse` |
   | same bridges | other (`rp2`, `stm32`, ...) or unknown | `unknown` | `rts-pulse` |
   | Espressif USB-Serial/JTAG 303A:1001 | `esp32` | `likely` | `usb-jtag` (esptool `USBJTAGSerialReset` sequence) |
   | Espressif 303A:xxxx other (MicroPython TinyUSB CDC) | `esp32` | `unknown` | none until measured |
   | Raspberry Pi RP2 2E8A:*, STM32 0483:*, SAMD 239A/04D8, nRF 1915 | any | `unlikely` | `none` |
   | URL/pty transports | any | `unlikely` (`basis:"transport"`) | `none` |
   | anything else | any | `unknown` | `rts-pulse` |
3. Instructor's board: `verified` after session 1 for the **open** sequences V2/V3 (the same EN toggling); the explicit `rts-pulse` of kit stage E is still to be measured, and `verified` for the RTS pulse itself is only recorded by the verification in section 3.

**UI gating (context key `upy-bridge.hardResetAvailable`)**: the "Reset with RTS/DTR line" option is offered when `state` is `verified` or `likely`; it is hidden when `unlikely` or `failed`; for `unknown` it is hidden by default and a Doctor entry explains how to run the verification. A setting `upy-bridge.reset.showUnverifiedHardReset` (default `false`) shows it for `unknown`. The "Reset board..." row itself is always present and lists the options that apply, so a student on a Pico still gets "Restart Python" and "Reboot board".

## 3. Verification procedure (explicit, once per board, only on request or first use)

`reset.hard {"confirmed": true, "verify": true}` performs the pulse and decides whether it worked:

1. Before: if the board is idle and the REPL answers, read `time.ticks_ms()` and `machine.reset_cause()` (read-only, through the normal file-op path); remember `uptime_before`. If the board is hung, there is no "before" and only evidence 2 or 3 below counts.
2. Pulse per the capability's `method` (DTR low, RTS high ~100 ms, RTS low; `usb-jtag` uses its own sequence).
3. Evidence of a reset within 3 s: (a) ROM/boot text on the stream (the kit's `ROM_RE`: `ets ... rst:0x`, `boot:0x`, `configsip`, `load:0x`, `waiting for download`); (b) `ticks_ms` after is smaller than `uptime_before` or small (< 10 s) when `uptime_before` was larger; (c) the port re-enumerates (native USB). Any one of (a)-(c) is `verified`; none is `failed` (cache with the adapter/board key and reason). `waiting for download` in (a) means the lines left the chip in the ROM bootloader: report it, re-pulse with DTR kept low, and mark the method `unsafe-sequence` if it persists.
4. After a successful pulse the bridge returns to `connecting` and re-syncs to the prompt without further resets (RQ-SAFE-1), emitting `state` events with `reason:"board-reset"`.

A verification resets the board by definition, so it follows the checklist and `resetWarning` like any other hard reset, and it is never run automatically.

## 4. Protocol changes

| op | args | result | queue class | notes |
|---|---|---|---|---|
| `reset.capability` | | see section 2 | none | no I/O except what `identity` already gathered |
| `reset.machine` | `confirmed:true` | `{"phase": "sent"}` then state events | run | requires idle (or consented interrupt); sends `import machine; machine.reset()` through the raw REPL **with the command acknowledged-not-awaited**; tolerates the link dropping; on native-USB boards the port vanishes and returns: state `disconnected` with `reason:"board-reset"`, the **client** may reconnect to the same VID/PID/serial within a bounded window (the Windows COM number can change; the bridge reports the old name and `ports.list` shows the new) |
| `reset.hard` | `confirmed:true`, `verify?`, `method?` | `{"verified": bool\|null, "evidence": [..]}` | run | only reachable from this op; `E_UNSUPPORTED` when `hard.state` is `unlikely`, `failed` (unless `force:true`) or `method` is `none` |

New error code: `E_RESET_NOT_OBSERVED` (verification found no evidence; the board may be hung or the wiring absent; hint: use the EN button or replug).
New events: none (uses `state` with `reason:"board-reset"`).

## 5. Rules (extend RQ-SAFE-2)

- No tier above `soft` is ever sent implicitly: not on connect, disconnect, Run, Stop escalation, auto-sync or reconnect (RQ-SAFE-1/2). **Stop never escalates to a reset**; when Stop times out the UI *offers* "Reset board..." (the available options only).
- `reset.machine` does not need the control lines, so it is the recommended reboot for students; `reset.hard` is the rescue tool.
- The confirmation text includes the profile's `resetWarning`; "Don't ask again this session" is allowed per tier.
- The old extension's "Soft Reset" button actually performed `machine.reset()` when no REPL was open (old-defects 02.x, 04.x). New labels: **Restart Python (soft reset)**, **Reboot board (software)**, **Reset with RTS/DTR line**.
- Fake board support (RQ-GEN-4): profiles declare `reset_wiring: "auto-reset"|"none"|"usb-jtag"`; over TCP the fake models the pulse as an out-of-band control message so tests can assert: capability states per profile, `machine` reset (interpreter restart + port drop for native-USB profiles), hard reset verification success and `failed` when wiring is `none`, no reset ever sent without `confirmed:true`.
