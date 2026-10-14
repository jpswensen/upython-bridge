#!/usr/bin/env python3
"""mpunix_relay.py - expose the REAL MicroPython unix port (REPL on a pty) as socket://127.0.0.1:PORT.
POSIX only (pty). Used to validate the protocol assumptions of the fake board against real
MicroPython REPL code (shared/runtime/pyexec.c). Usage: mpunix_relay.py MICROPYTHON_BIN CWD"""
import os, pty, select, socket, subprocess, sys, termios, tty

mp_bin, cwd = sys.argv[1], sys.argv[2]
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", 0)); srv.listen(1)
print("LISTENING socket://127.0.0.1:%d" % srv.getsockname()[1], flush=True)
while True:
    conn, _ = srv.accept()
    master, slave = pty.openpty()
    tty.setraw(slave)  # no ONLCR/echo from the line discipline; MicroPython does its own cooking
    proc = subprocess.Popen([mp_bin], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, close_fds=True)
    os.close(slave)
    try:
        while True:
            r, _, _ = select.select([master, conn], [], [], 0.5)
            if master in r:
                try:
                    d = os.read(master, 4096)
                except OSError:
                    break
                if not d:
                    break
                conn.sendall(d)
            if conn in r:
                d = conn.recv(4096)
                if not d:
                    break
                os.write(master, d)
            if proc.poll() is not None and master not in r:
                break
    finally:
        proc.kill(); proc.wait(); os.close(master); conn.close()
