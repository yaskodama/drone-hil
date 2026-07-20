#!/usr/bin/env python3
"""dist_dining_bench.py — 2-node distributed dining philosophers, 50 meals.

The 5 philosophers are split 3 + 2 across two bare-metal Xinu nodes, run IN
PARALLEL, and aggregated:
  * Pi4 (10.0.0.1) — AIPL JIT, a 3-philosopher ring (dining3_xinu.abcl), 30 meals
    (3 x quota 10).  Driven by re-poking `dine` over /actor/send; GC via
    /api/actors-gc afterwards.
  * Pi3 (192.168.3.50) — built-in Chandy-Misra DiningBench (mode 3), 20 meals,
    started over /api/dining and polled via /api/dining/status (native, GC-integrated).

Distributed wall-clock = max(t_Pi4, t_Pi3); total meals = 30 + 20 = 50.
"""
import os, time, json, subprocess, urllib.request, threading

PI4    = "192.168.3.100"
PI3    = "192.168.3.50:8080"
AIPL2C = "/Users/kodamay/ocaml-app/abclcp-project/_build/default/src/aipl2c.exe"
ABCL3  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dining3_xinu.abcl")
P4_PHILS = [4, 5, 6]          # actor ids of the 3 philosophers on Pi4
P4_QUOTA = 10                 # 3 x 10 = 30 meals on Pi4
P3_MEALS = 20                 # 20 meals on Pi3
res = {}


def http(host, path, body=None, timeout=30, post=False):
    url = "http://%s%s" % (host, path)
    data = body.encode() if isinstance(body, str) else body
    m = "POST" if (post or data) else "GET"
    req = urllib.request.Request(url, data=data, method=m)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("ascii", "replace")


def _int(s):
    return int("".join(c for c in s if c.isdigit() or c == "-") or "0")


def run_pi4():
    src = open(ABCL3).read().replace("__QUOTA__", str(P4_QUOTA))
    open("/tmp/_d3.abcl", "w").write(src)
    subprocess.run([AIPL2C, "/tmp/_d3.abcl", "--xinu-jit", "--no-typecheck", "-o", "/tmp/_d3.c"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    csrc = open("/tmp/_d3.c").read().replace("v_nil", "v_int(0)").encode()
    t0 = time.time()
    http(PI4, "/actor/load", body=csrc, timeout=40)
    pokes = 0
    while True:
        m = [_int(http(PI4, "/actor/send?to=%d&m=get_meals&arg=0" % i, timeout=8)) for i in P4_PHILS]
        if sum(m) >= P4_QUOTA * len(P4_PHILS):
            break
        for i, mi in zip(P4_PHILS, m):
            if mi < P4_QUOTA:
                http(PI4, "/actor/send?to=%d&m=dine&arg=0" % i, timeout=8); pokes += 1
        if time.time() - t0 > 90:
            break
    ms = int((time.time() - t0) * 1000)
    m = [_int(http(PI4, "/actor/send?to=%d&m=get_meals&arg=0" % i, timeout=8)) for i in P4_PHILS]
    g0 = time.time()
    gc = http(PI4, "/api/actors-gc?threshold_ms=0&dry=0", timeout=15)
    res["pi4"] = {"node": "Pi4 (AIPL 3-phil)", "meals_each": m, "meals": sum(m),
                  "ms": ms, "pokes": pokes, "gc_ms": int((time.time()-g0)*1000)}


def run_pi3():
    http(PI3, "/api/dining/init", post=True, timeout=10)
    t0 = time.time()
    http(PI3, "/api/dining/start?mode=3&meals=%d" % P3_MEALS, post=True, timeout=10)
    elapsed = 0; ndone = ""; final = False
    while time.time() - t0 < 90:
        s = http(PI3, "/api/dining/status", timeout=8)
        if "elapsed_ms=" in s:
            elapsed = _int(s.split("elapsed_ms=")[1])
        if "n_done=" in s:
            ndone = s.split("n_done=")[1].split()[0]
        if "final=yes" in s:
            final = True; break
        time.sleep(1.0)
    ms = int((time.time() - t0) * 1000)
    res["pi3"] = {"node": "Pi3 (CM DiningBench)", "meals": P3_MEALS, "n_done": ndone,
                  "elapsed_ms": elapsed, "wall_ms": ms, "final": final}


if __name__ == "__main__":
    t0 = time.time()
    tp4 = threading.Thread(target=run_pi4)
    tp3 = threading.Thread(target=run_pi3)
    tp4.start(); tp3.start()
    tp4.join(); tp3.join()
    wall = int((time.time() - t0) * 1000)
    total_meals = res.get("pi4", {}).get("meals", 0) + res.get("pi3", {}).get("meals", 0)
    out = {"pi4": res.get("pi4"), "pi3": res.get("pi3"),
           "total_meals": total_meals, "wall_ms": wall,
           "dist_wall_ms": max(res.get("pi4", {}).get("ms", 0), res.get("pi3", {}).get("wall_ms", 0))}
    print(json.dumps(out, indent=2))
    open("/tmp/dist_dining_results.json", "w").write(json.dumps(out, indent=2))
