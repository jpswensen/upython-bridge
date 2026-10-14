# Runs ON THE BOARD via `mpremote exec` (or from a file).  Tiny, RAM-friendly alternative to
# micropython-stubber's createstubs.py for the "what exactly is in my custom module" question.
# Prints one line:  @@MPYINTRO@@{json}
import sys

try:
    import json
except ImportError:
    import ujson as json

MODULES = ("motorctl", "robotics_lab", "labkit", "imu_mpu6050")   # filled in by the extension


def kind(o):
    t = type(o).__name__
    if t in ("function", "closure", "bound_method", "builtin_function_or_method"):
        return "func"
    if t == "type":
        return "class"
    if t == "module":
        return "module"
    if t in ("int", "float", "str", "bool", "bytes", "NoneType", "tuple", "list", "dict"):
        return t
    return "obj"


def walk(o, depth):
    out = {}
    for n in dir(o):
        if n.startswith("__") and n.endswith("__"):
            continue
        try:
            v = getattr(o, n)
        except Exception:
            out[n] = {"k": "unreadable"}
            continue
        k = kind(v)
        e = {"k": k}
        if k in ("int", "float", "str", "bool"):
            e["v"] = v
        if k == "class" and depth < 2:
            e["members"] = walk(v, depth + 1)
        out[n] = e
    return out


res = {"impl": {"name": sys.implementation.name, "version": list(sys.implementation.version[:3]),
                "build": getattr(sys.implementation, "_build", ""), "platform": sys.platform}, "mods": {}}
for m in MODULES:
    try:
        res["mods"][m] = walk(__import__(m), 0)
    except Exception as e:
        res["mods"][m] = {"error": repr(e)}
print("@@MPYINTRO@@" + json.dumps(res))
