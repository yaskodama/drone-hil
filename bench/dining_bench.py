#!/usr/bin/env python3
"""dining_bench.py — real on-device benchmark of the type-inference-clean dining
philosophers (dining_xinu.abcl) on the Xinu Pi 4 JIT runtime, WITH GC.

5 philosophers x quota meals = `total` meals.  The JIT pump drains a finite
message budget per /actor/load and then quiesces, so a self-sustaining actor
loop (the dining ring) is driven to completion by re-poking `dine` over the
HTTP gateway until every philosopher reaches its quota.  We time the whole
drive, then run the actor GC (/api/actors-gc) to reclaim the 11 resident
fork/philosopher/table actors (which, unlike the N-Queens solvers, never
suicide), reporting how many it sweeps and how long that takes.
"""
import os, sys, time, json, subprocess, urllib.request

PI     = os.environ.get("PI4", "192.168.3.100")
AIPL2C = "/Users/kodamay/ocaml-app/abclcp-project/_build/default/src/aipl2c.exe"
ABCL   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dining_xinu.abcl")
PHILS  = [6, 7, 8, 9, 10]          # actor ids: root=0, forks=1..5, philosophers=6..10


def http(path, body=None, timeout=30):
    url = "http://%s%s" % (PI, path)
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=("POST" if data else "GET"))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("ascii", "replace")


def _int(s):
    return int("".join(c for c in s if c.isdigit() or c == "-") or "0")


def gen_c(quota):
    src = open(ABCL).read().replace("__QUOTA__", str(quota))
    ap, cp = "/tmp/_din_%d.abcl" % quota, "/tmp/_din_%d.c" % quota
    open(ap, "w").write(src)
    subprocess.run([AIPL2C, ap, "--xinu-jit", "--no-typecheck", "-o", cp],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return open(cp).read().replace("v_nil", "v_int(0)").encode()


def meals():
    return [_int(http("/actor/send?to=%d&m=get_meals&arg=0" % i, timeout=8)) for i in PHILS]


def bench(total):
    quota = total // 5
    csrc = gen_c(quota)
    t0 = time.time()
    http("/actor/load", body=csrc, timeout=40)          # round 1 (pump budget)
    pokes = 0
    while True:
        m = meals()
        if sum(m) >= total:
            break
        for i, mi in zip(PHILS, m):
            if mi < quota:
                http("/actor/send?to=%d&m=dine&arg=0" % i, timeout=8)  # re-drive
                pokes += 1
        if time.time() - t0 > 90:
            break
    ms = int((time.time() - t0) * 1000)
    m = meals()
    # --- GC: reclaim the resident (non-suiciding) dining actors ---
    g0 = time.time()
    gc = http("/api/actors-gc?threshold_ms=0&dry=0", timeout=15)
    gc_ms = int((time.time() - g0) * 1000)
    rec = {
        "total": total, "quota": quota, "meals_each": m, "meals_sum": sum(m),
        "ok": (sum(m) == total), "ms": ms, "pokes": pokes,
        "ms_per_meal": round(ms / total, 2) if total else 0,
        "gc_ms": gc_ms, "gc": gc.replace("\n", " ")[:120],
    }
    print(json.dumps(rec))
    return rec


if __name__ == "__main__":
    totals = [int(x) for x in sys.argv[1:]] or [25, 50, 100]
    print("[dining] PI=%s totals=%s" % (PI, totals), file=sys.stderr)
    out = []
    for t in totals:
        try:
            out.append(bench(t))
        except Exception as e:
            print(json.dumps({"total": t, "error": str(e)}))
        time.sleep(0.5)
    open("/tmp/dining_bench_results.json", "w").write(json.dumps(out, indent=2))
    print("[dining] wrote /tmp/dining_bench_results.json", file=sys.stderr)
