#!/usr/bin/env python3
"""nqueens_bench.py — real on-device benchmark of the first-row-partitioned
distributed N-Queens (dist_nqueens_xinu.abcl) on the Xinu Pi 4 JIT runtime.

For each N it times three real /actor/load runs:
  - FULL      partition [0, N)         -> total solution count (sanity: known)
  - LEFT      partition [0, ceil(N/2)) -> one mesh node's share
  - RIGHT     partition [ceil(N/2), N) -> the other node's share
LEFT.count + RIGHT.count must equal FULL.count (loss-free split).

The 2-node distributed wall-clock is modelled as
    T_dist = max(T_left, T_right) + 2 * RTT_mesh
(dispatch the range + collect the count over the WiFi mesh), and speedup is
    S = T_full / T_dist.

Protocol mirrors pool_xinu_driver.py: aipl2c --xinu-jit -> POST /actor/load ->
poll GET /actor/send?to=0&m=get_done -> GET .../m=get_solutions.
"""
import os, sys, time, json, math, subprocess, urllib.request

PI       = os.environ.get("PI4", "192.168.3.100")
AIPL2C   = "/Users/kodamay/ocaml-app/abclcp-project/_build/default/src/aipl2c.exe"
ABCL     = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist_nqueens_xinu.abcl")
RTT_MESH = float(os.environ.get("RTT_MESH_MS", "15.0"))   # measured WiFi-IBSS RTT
KNOWN    = {1:1,2:0,3:0,4:2,5:10,6:4,7:40,8:92,9:352,10:724,11:2680,12:14200}


def http(path, body=None, timeout=20):
    url = "http://%s%s" % (PI, path)
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=("POST" if data else "GET"))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("ascii", "replace")


def _int(s):
    return int("".join(ch for ch in s if ch.isdigit() or ch == "-") or "0")


def gen_c(n, lo, hi):
    src = open(ABCL).read().replace("__N__", str(n)).replace("__LO__", str(lo)).replace("__HI__", str(hi))
    ap = "/tmp/_nq_%d_%d_%d.abcl" % (n, lo, hi)
    cp = ap[:-5] + ".c"
    open(ap, "w").write(src)
    subprocess.run([AIPL2C, ap, "--xinu-jit", "--no-typecheck", "-o", cp],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    c = open(cp).read()
    # Pi4 JIT cc has no `v_nil` symbol; the (type-clean) `nil` actor-ref init
    # emits it. The nil parent on the root is never used as a send target, so
    # map it to v_int(0) for the on-device runtime.
    c = c.replace("v_nil", "v_int(0)")
    return c.encode()


def run_partition(n, lo, hi, timeout_s=60):
    """Load the [lo,hi) partition. /actor/load runs the actors synchronously and
    only replies once quiescent, so the load-call duration IS the on-device time
    (JIT compile + actor run). Returns (count, ms, completed)."""
    csrc = gen_c(n, lo, hi)
    t0 = time.time()
    reply = http("/actor/load", body=csrc, timeout=timeout_s)
    ms = int((time.time() - t0) * 1000)
    done = _int(http("/actor/send?to=0&m=get_done&arg=0", timeout=10))
    count = _int(http("/actor/send?to=0&m=get_solutions&arg=0", timeout=10))
    if "undefined" in reply or "error" in reply.lower():
        raise RuntimeError("load failed: " + reply[:80])
    return count, ms, (done >= 1)


def bench_n(n):
    h = (n + 1) // 2
    full,  t_full,  okf = run_partition(n, 0, n)
    left,  t_left,  okl = run_partition(n, 0, h)
    right, t_right, okr = run_partition(n, h, n)
    t_dist = max(t_left, t_right) + 2 * RTT_MESH
    rec = {
        "n": n, "known": KNOWN.get(n),
        "full_count": full, "left_count": left, "right_count": right,
        "split_ok": (left + right == full), "value_ok": (full == KNOWN.get(n)),
        "t_full_ms": t_full, "t_left_ms": t_left, "t_right_ms": t_right,
        "t_dist_ms": round(t_dist, 1), "speedup": round(t_full / t_dist, 3) if t_dist else 0,
        "completed": okf and okl and okr,
    }
    print(json.dumps(rec))
    return rec


if __name__ == "__main__":
    ns = [int(x) for x in sys.argv[1:]] or [6, 7, 8]
    print("[bench] PI=%s RTT_MESH=%.1fms Ns=%s" % (PI, RTT_MESH, ns), file=sys.stderr)
    out = []
    for n in ns:
        try:
            out.append(bench_n(n))
        except Exception as e:
            print(json.dumps({"n": n, "error": str(e)}))
    open("/tmp/nq_bench_results.json", "w").write(json.dumps(out, indent=2))
    print("[bench] wrote /tmp/nq_bench_results.json (%d rows)" % len(out), file=sys.stderr)
