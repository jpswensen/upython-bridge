"""resetcap.py - the hard-reset capability estimator (docs/protocol-addendum-reset.md section 2, D-16, RQ-RESET-3/4).

Pure and data driven: no I/O, no pyserial, no dependency on any other bridge module.

    estimate(vid, pid, platform, kind, learned=None) -> {"state", "method", "reason", "basis"}

    state   "verified" | "likely" | "unknown" | "unlikely" | "failed"
    method  "rts-pulse" | "usb-jtag" | "none"
    reason  English, for the Doctor / the confirmation dialog
    basis   "learned" | "adapter" | "transport"

Whether a PCB has the auto-reset transistors is invisible over USB, so this is an ESTIMATE until a verification
(`reset.hard {verify:true}`) observed a reset; that result comes back from the client as `learned`
("verified" | "failed"; the cache lives in the extension's storage, keyed by (VID, PID, machine.unique_id())).

Order of evidence (first match wins):
  1. transport: a pyserial URL or a pty has no modem lines -> unlikely / none (learned is ignored: "for URL transports no
     record"). A caller that registered a line driver on the Link (tests) passes kind="device" instead.
  2. learned: "verified" / "failed" for a real device.
  3. adapter table below (extend it as hardware sessions add evidence; every row is [K]/[U] until measured).

The table is data: ROWS is evaluated top to bottom, a row matches on (vid, pids) and says what the platform decides.
"""
from __future__ import annotations

__all__ = ["estimate", "native_usb", "STATES", "METHODS", "LEARNED", "ROWS", "UART_BRIDGES", "NATIVE_USB_VIDS", "HARD_STATES_OFFERED"]

STATES = ("verified", "likely", "unknown", "unlikely", "failed")
METHODS = ("rts-pulse", "usb-jtag", "none")
LEARNED = ("verified", "failed")
HARD_STATES_OFFERED = ("verified", "likely")   # the UI offers "Reset with RTS/DTR line" for these (RQ-RESET-3)

# USB-UART bridges that normally sit behind an EN/IO0 auto-reset circuit on ESP boards.
UART_BRIDGES = {
    (0x10C4, 0xEA60): "CP210x",
    (0x1A86, 0x7523): "CH340",
    (0x1A86, 0x55D4): "CH9102",
    (0x1A86, 0x55D3): "CH343",
    (0x0403, 0x6001): "FTDI FT232",
    (0x0403, 0x6010): "FTDI FT2232",
    (0x0403, 0x6015): "FTDI FT231X",
}
# Boards that run MicroPython on a native USB device: no control lines exist for a reset pulse.
# 0xF055 (MicroPython's own VID, the pyboard CDC) is added next to the addendum's list: it is native USB like 0x0483.
NATIVE_USB_VIDS = {
    0x2E8A: "Raspberry Pi RP2",
    0x0483: "STM32",
    0xF055: "MicroPython (pyboard)",
    0x239A: "Adafruit / SAMD",
    0x04D8: "Microchip SAMD",
    0x1915: "Nordic nRF",
}
_ESP_PLATFORMS = ("esp32", "esp8266")
_ESPRESSIF_VID = 0x303A
_USB_SERIAL_JTAG = (0x303A, 0x1001)


def _result(state, method, reason, basis):
    return {"state": state, "method": method, "reason": reason, "basis": basis}


def _usb_id(v):
    """A USB vendor/product id: an int in 0..0xFFFF, else None. Anything else (bool, str, float, out of range) is unknown."""
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 0xFFFF else None


def native_usb(vid):
    """True when the board's USB port itself vanishes and returns on a chip reset (a native USB device: Espressif
    USB-Serial/JTAG or TinyUSB CDC, RP2, STM32, SAMD, nRF). A UART bridge (CP210x, CH340, FTDI) keeps its port across a chip
    reset, so a port that vanishes behind one - or behind an adapter nobody knows - is an unplug, never evidence of a reset."""
    vid = _usb_id(vid)
    return vid is not None and (vid == _ESPRESSIF_VID or vid in NATIVE_USB_VIDS)


def _norm_platform(platform):
    return platform.strip().lower() if isinstance(platform, str) and platform.strip() else None


# Each row: (matcher(vid, pid) -> label or None, {platform tuple or None: (state, method)}, default (state, method), text)
# "platforms": the first entry whose key contains the platform wins; "default" applies otherwise (including an unread identity).
def _bridge(vid, pid):
    return UART_BRIDGES.get((vid, pid))


def _jtag(vid, pid):
    return "Espressif USB-Serial/JTAG" if (vid, pid) == _USB_SERIAL_JTAG else None


def _espressif_other(vid, pid):
    return "Espressif native USB (TinyUSB CDC)" if vid == _ESPRESSIF_VID else None


def _native(vid, pid):
    return NATIVE_USB_VIDS.get(vid)


ROWS = (
    (_bridge, {_ESP_PLATFORMS: ("likely", "rts-pulse")}, ("unknown", "rts-pulse"),
     "%s USB-UART bridge on an ESP board normally drives EN/IO0 through RTS/DTR"),
    (_jtag, {("esp32",): ("likely", "usb-jtag")}, ("unknown", "usb-jtag"),
     "the %s peripheral answers the esptool reset sequence"),
    (_espressif_other, {("esp32",): ("unknown", "none")}, ("unknown", "none"),
     "%s: no reset sequence has been measured"),
    (_native, {}, ("unlikely", "none"),
     "%s boards are native USB and have no auto-reset lines"),
)


def estimate(vid, pid, platform, kind, learned=None):
    """The capability of the hard-reset (control line pulse) tier for one connection. Pure.

    vid, pid  ints from ports.list / pyserial, or None when unknown
    platform  identity.platform ("esp32", "rp2", ...) or None while the identity has not been read
    kind      "device" | "pty" | "url" (Link.port_info["kind"]; pass "device" when a line driver stands in for the lines)
    learned   None | "verified" | "failed": the client's cached verification result for this board
    """
    if learned is not None and learned not in LEARNED:
        raise ValueError("learned must be None, 'verified' or 'failed', not %r" % (learned,))
    if kind in ("url", "pty"):
        return _result("unlikely", "none",
                       "this connection (%s) has no modem lines, so no control line pulse is possible" % kind, "transport")
    vid, pid = _usb_id(vid), _usb_id(pid)   # a caller bug (str, float, bool) must not crash the capability: it is "unknown"
    plat = _norm_platform(platform)
    state, method, reason = _adapter_estimate(vid, pid, plat)
    if learned == "verified":
        return _result("verified", method if method != "none" else "rts-pulse",
                       "An earlier verification saw this board reset when the control lines were pulsed.", "learned")
    if learned == "failed":
        return _result("failed", method if method != "none" else "rts-pulse",
                       "An earlier verification saw no reset when the control lines were pulsed (the board may lack the "
                       "auto-reset wiring or was hung). Use the board's EN/reset button or replug it.", "learned")
    return _result(state, method, reason, "adapter")


def _adapter_estimate(vid, pid, plat):
    if vid is None:
        return "unknown", "rts-pulse", "The USB adapter is unknown, so the reset wiring cannot be estimated."
    for matcher, by_platform, default, text in ROWS:
        label = matcher(vid, pid)
        if label is None:
            continue
        st, me = default
        for platforms, verdict in by_platform.items():
            if plat in platforms:
                st, me = verdict
                break
        shown = "%s (%04X:%04X)" % (label, vid, pid if pid is not None else 0)
        why = text % shown
        if st == "unknown" and plat is None:
            why += "; the board's platform has not been read yet"
        elif st == "unknown":
            why += "; not known to be wired for reset on platform %s" % plat
        return st, me, why[0].upper() + why[1:] + "."
    return "unknown", "rts-pulse", "The adapter %04X:%04X is not in the estimate table." % (vid, pid if pid is not None else 0)
