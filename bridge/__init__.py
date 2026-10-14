"""mpy-upgrade bridge package: the Python side that owns the serial port.

Modules: errors (BridgeError, classify_open_error), link (Link: raw REPL, raw paste, policies).
The package imports nothing at import time; `from bridge.link import Link` pulls in vendored pyserial.
"""
__version__ = "0.1.0"
