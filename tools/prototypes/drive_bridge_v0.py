#!/usr/bin/env python3
"""Stand-in for the VS Code extension: drives bridge_proto.py over JSON lines and
checks the behaviours that the stateless design cannot provide."""
import base64, json, os, queue, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
url = sys.argv[1]
proc = subprocess.Popen([os.environ.get("BRIDGE_PY", sys.executable)] + os.environ.get("BRIDGE_FLAGS", "").split() + [os.path.join(HERE, "bridge_proto.py")],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
replies, events = {}, queue.Queue()
nid = [0]

def reader():
    for line in proc.stdout:
        m = json.loads(line)
        if "ev" in m:
            events.put(m)
        else:
            replies[m["id"]] = m

threading.Thread(target=reader, daemon=True).start()

def call(op, timeout=30, **kw):
    nid[0] += 1
    i = nid[0]
    proc.stdin.write(json.dumps({"id": i, "op": op, **kw}) + "\n"); proc.stdin.flush()
    t0 = time.time()
    while i not in replies:
        if time.time() - t0 > timeout:
            raise TimeoutError(op)
        time.sleep(0.005)
    r = replies.pop(i)
    if not r.get("ok"):
        raise RuntimeError("%s failed: %s" % (op, r))
    return r

def drain(until=None, timeout=3.0):
    buf = b""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            e = events.get(timeout=0.05)
        except queue.Empty:
            if until is not None and until in buf:
                break
            continue
        buf += base64.b64decode(e["b64"])
        if until is not None and until in buf:
            break
    return buf

print("connect:", call("connect", port=url))

# 1) 20-file upload + manifest in ONE port session
many = os.path.join(HERE, "many")
t0 = time.time()
for n in sorted(os.listdir(many)):
    call("put", local=os.path.join(many, n), remote="/proj2/" + n)
t_up = time.time() - t0
man = call("manifest", path="/proj2")["files"]
print("uploaded %d files in %.2fs via bridge; manifest entries=%d first=%s" % (len(os.listdir(many)), t_up, len(man), man[0]))

# 2) run a script, streaming events, no REPL open
open(os.path.join(HERE, "loop.py"), "w").write("import time\nfor i in range(3):\n    print('tick', i)\n    time.sleep(0.05)\n")
r = call("run", local=os.path.join(HERE, "loop.py"))
print("run stderr:", repr(r["stderr"]), "| output events:", drain(until=b"tick 2", timeout=2).decode().replace("\r\n", "|"))

# 3) open the REPL, type something, then do FILE OPS WHILE THE REPL IS OPEN, REPL state must survive
call("repl_open")
time.sleep(0.2); drain(timeout=0.5)
call("repl_write", b64=base64.b64encode(b"keepme = 123\r").decode())
print("repl echo 1:", drain(until=b">>> ", timeout=1.5).decode().replace("\r\n", "|"))
t0 = time.time()
ls = call("ls", path="/proj2")
print("ls while REPL open -> %d entries in %.2fs" % (len(ls["entries"]), time.time() - t0))
call("put", local=os.path.join(many, "f1.py"), remote="/while_repl_open.py")
drain(timeout=0.3)
call("repl_write", b64=base64.b64encode(b"keepme + 1\r").decode())
out = drain(until=b"124", timeout=2).decode().replace("\r\n", "|")
print("repl after file ops (state preserved -> expect 124):", out)

# 4) interrupt a long loop typed into the REPL
call("repl_write", b64=base64.b64encode(b"while True: pass\r").decode())
time.sleep(0.2)
t0 = time.time()
call("interrupt")
out = drain(until=b"KeyboardInterrupt", timeout=2).decode().replace("\r\n", "|")
print("interrupt (%.2fs):" % (time.time() - t0), out[-120:])
call("repl_close"); call("close")
proc.stdin.close(); proc.wait(timeout=5)
print("done")
