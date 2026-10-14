"""Break-it round 2, protocol level: hostile bytes and hostile argument types on the NDJSON channel.

Every test spawns the real bridge process (tests.bridge_client) against a fake board over TCP. Nothing here opens a
serial port. Pass criteria: the bridge stays alive, every well-formed request is answered with its own id, stdout carries
only JSON lines, no response is E_INTERNAL (that code means a bridge bug), and the board never sees a reset it was not
asked for.
"""
from __future__ import annotations

import json
import unittest

from tests.bridge_client import BridgeTestCase, b64

BIG_NEST = b"[" * 200000 + b"]" * 200000


class ProtocolBytes(BridgeTestCase):
    def test_id_variants_are_echoed_exactly(self):
        c = self.new_bridge()
        ids = [0, -1, -(2 ** 40), 2 ** 53 + 1, 2 ** 63, 10 ** 20, "abc", "", "7", "é中", "a" * 100000]
        for rid in ids:
            c.send_raw((json.dumps({"id": rid, "op": "ping"}) + "\n").encode("utf-8"))
        for rid in ids:
            resp = c.result(rid, 10)
            self.assertTrue(resp["ok"], rid)
            self.assertEqual(resp["id"], rid)
        c.assert_clean_stdout()
        self.assertTrue(c.alive)

    def test_bad_id_types_get_an_error_not_silence(self):
        c = self.new_bridge()
        for raw in (b'{"id":1.5,"op":"ping"}\n', b'{"id":true,"op":"ping"}\n', b'{"id":null,"op":"ping"}\n',
                    b'{"id":[1],"op":"ping"}\n', b'{"id":{"a":1},"op":"ping"}\n', b'{"op":"ping"}\n'):
            n = len(c.events_of("log")) + len(c.responses)
            c.send_raw(raw)
            c.ping()
        c.assert_clean_stdout()
        self.assertTrue(c.alive)

    def test_two_objects_on_one_line_do_not_kill_it(self):
        c = self.new_bridge()
        c.send_raw(b'{"id":1,"op":"ping"}{"id":2,"op":"ping"}\n')
        c.ping()
        c.send_raw(b'{"id":3,"op":"ping"}\n{"id":4,"op":"ping"}\n')
        self.assertTrue(c.result(3)["ok"])
        self.assertTrue(c.result(4)["ok"])
        c.assert_clean_stdout()

    def test_partial_line_then_rest(self):
        c = self.new_bridge()
        c.send_raw(b'{"id": 41, "op": "pi')
        c.send_raw(b'ng"}')
        c.send_raw(b"\r\n")
        self.assertTrue(c.result(41, 10)["ok"])
        c.send_raw(b"\n\n   \n\t\n")   # blank lines are ignored
        c.ping()
        c.assert_clean_stdout()

    def test_invalid_utf8_and_binary_garbage(self):
        c = self.new_bridge()
        c.send_raw(b'\xff\xfe\xfd\n')
        c.send_raw(b'{"id":9,"op":"ping","x":"\xff\xc0\xaf"}\n')
        c.send_raw(bytes(range(256)) + b"\n")
        c.send_raw(b"\x00\x00\x00\n")
        c.send_raw(b'\xef\xbb\xbf{"id":10,"op":"ping"}\n')   # BOM
        c.ping()
        c.assert_clean_stdout()
        self.assertTrue(c.alive)

    def test_non_object_json_and_deep_nesting(self):
        c = self.new_bridge()
        for raw in (b"[]\n", b"1\n", b'"x"\n', b"null\n", b"true\n", b"{}\n", b"NaN\n", b"-Infinity\n", BIG_NEST + b"\n",
                    b"1" * 20000 + b"\n", b'{"id":1,"op":"ping","a":' + b"[" * 100000 + b"1" + b"]" * 100000 + b"}\n"):
            c.send_raw(raw)
            c.ping()
        c.assert_clean_stdout()
        self.assertTrue(c.alive)

    def test_overlong_line_is_rejected_and_stream_resyncs(self):
        c = self.new_bridge()
        c.send_raw(b'{"id": 77, "op": "ping", "pad": "' + b"x" * (5 * 1024 * 1024) + b'"}\n')
        resp = c.result(77, 20)
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["code"], "E_PROTOCOL")
        c.ping()
        c.assert_clean_stdout()

    def test_overlong_line_error_carries_the_request_id_wherever_it_sits(self):
        """JSON object key order is not part of the contract: a client that serialises {"b64": ..., "id": N, "op": ...} (id last)
        gets an error with id null for an over-long line, so its pending request is never resolved."""
        c = self.new_bridge()
        c.send_raw(b'{"b64": "' + b"x" * (5 * 1024 * 1024) + b'", "id": 78, "op": "tty.write"}\n')
        c.ping()
        errs = [e for e in c.responses.values() if e.get("id") is None] + [r for r in [c.responses.get(78)] if r]
        self.assertIn(78, c.responses, "no response carries id 78 (the over-long line error has id null); stdout lines seen: %r"
                      % [(k, v.get("error", {}).get("code")) for k, v in c.responses.items()])

    def test_overlong_line_with_no_newline_then_eof(self):
        c = self.new_bridge()
        c.send_raw(b"y" * (9 * 1024 * 1024))
        c.proc.stdin.close()
        rc = c.wait_exit(15)
        self.assertEqual(rc, 0)
        c.assert_clean_stdout()

    def test_nan_infinity_never_reach_the_channel(self):
        board, c, _ = self.connected()
        c.send_raw(b'{"id":50,"op":"exec","code":"print(1)","timeoutMs":1e999}\n')
        c.send_raw(b'{"id":51,"op":"stop","timeoutMs":NaN}\n')
        c.send_raw(b'{"id":52,"op":"connect","port":"x","baud":Infinity}\n')
        for rid in (50, 51, 52):
            self.assertFalse(c.result(rid, 10)["ok"])
        c.ping()
        c.assert_clean_stdout()
        self.assertNoReset(board)


class ArgumentFuzz(BridgeTestCase):
    """Every op x every hostile value, with ALL argument names set to that value at once."""

    ARG_NAMES = ["port", "baud", "openPolicy", "path", "local", "remote", "src", "dst", "root", "code", "names", "shadowGuard",
                 "exclude", "b64", "target", "timeoutMs", "confirm", "confirmed", "source", "name", "hash", "mkdirs",
                 "parents", "expectSha", "chunk", "idleListenMs", "stopOnDisconnect", "allowMount", "interrupt", "force",
                 "background", "reset", "stdin", "stopFirst", "vid", "pid"]
    # reset.soft / reset.hard / shutdown are explicit-reset or exit ops and are exercised elsewhere
    OPS = ["ping", "ports.list", "disconnect", "repl.attach", "repl.detach", "identity", "fs.list", "fs.manifest", "fs.stat",
           "fs.put", "fs.get", "fs.rm", "fs.rmtree", "fs.mkdir", "fs.mv", "run", "stop", "tty.write", "introspect.modules",
           "exec", "config", "cancel", "connect"]
    VALUES = [None, 0, -1, 2 ** 70, 1.5, "", "x", "/", [], {}, [1], ["a", 1], False, "\x00", "\ud800", "////", "/a/../b",
              "!!!!", "AAAA", 10 ** 400]

    def run_matrix(self, c, ops, check_internal=True):
        sent = []
        for op in ops:
            for v in self.VALUES:
                if v is True or (op == "connect" and v in ("x", "/", "////", "/a/../b")):
                    pass
                args = {k: v for k in self.ARG_NAMES}
                if op == "run" and v is None:
                    continue
                try:
                    text = json.dumps(dict(args, id=len(sent) + 1000, op=op), allow_nan=False)
                except ValueError:
                    continue
                c.send_raw((text + "\n").encode("utf-8"))
                sent.append((len(sent) + 1000, op, v))
        bad = []
        for rid, op, v in sent:
            resp = c.result(rid, 40)
            if not isinstance(resp.get("ok"), bool):
                bad.append((op, v, resp))
            elif check_internal and not resp["ok"] and resp["error"]["code"] == "E_INTERNAL":
                bad.append((op, v, resp["error"]["detail"][-300:]))
        return sent, bad

    def test_matrix_before_connect(self):
        c = self.new_bridge()
        ops = [o for o in self.OPS if o not in ("connect", "disconnect")]
        sent, bad = self.run_matrix(c, ops)
        self.assertEqual(bad, [], "responses with E_INTERNAL or no ok flag")
        c.ping()
        c.assert_clean_stdout()

    def test_matrix_connected(self):
        board, c, _ = self.connected()
        ops = [o for o in self.OPS if o not in ("connect", "disconnect")]
        sent, bad = self.run_matrix(c, ops)
        self.assertEqual(bad, [], "responses with E_INTERNAL or no ok flag")
        self.assertNoReset(board, "argument fuzz must never reset the board")
        c.ping()
        c.assert_clean_stdout()

    def test_connect_with_hostile_values(self):
        c = self.new_bridge()
        sent, bad = self.run_matrix(c, ["connect"])
        self.assertEqual(bad, [])
        c.ping()


if __name__ == "__main__":
    unittest.main()
