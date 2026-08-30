#!/usr/bin/env python3
"""現行 AIPL の N-クイーンズを Xinu Pi5 実機で測る。
   各 N について「本番(lo=0,hi=N)」と「素通し(lo=hi=0・同じCコード)」を交互に測り、
   差でネットワーク+JITコンパイルの分を落とす。集計値だけでなく全試行を残す。"""
import subprocess, re, time, json, sys, statistics as st

BOARD = "http://192.168.3.101"
AIPL2C = "/Users/kodamay/ocaml-app/abclcp-project/_build/default/src/aipl2c.exe"
SRC = "nqueens_latest.aipl"
GAP = 2.5                      # ボードは連続リクエストに弱い
REPS = int(sys.argv[1]) if len(sys.argv) > 1 else 7
NS   = [4, 5, 6, 7]
EXPECT = {4: 2, 5: 10, 6: 4, 7: 40}

def gen(n, lo, hi, out):
    s = open(SRC, encoding="utf-8").read()
    s = s.replace("__N__", str(n)).replace("__LO__", str(lo)).replace("__HI__", str(hi))
    open("/tmp/_nq.aipl", "w", encoding="utf-8").write(s)
    subprocess.run([AIPL2C, "/tmp/_nq.aipl", "--xinu-jit", "--no-typecheck", "-o", out],
                   capture_output=True, timeout=120, check=True)
    c = open(out, encoding="utf-8").read().replace("v_nil", "v_int(0)")
    open(out, "w", encoding="utf-8").write(c)
    return len(c)

def post(cfile):
    r = subprocess.run(["curl", "-s", "-m", "180", "--data-binary", "@" + cfile,
                        "-X", "POST", BOARD + "/actor/load", "-w", "\n@@%{time_total}"],
                       capture_output=True, text=True, timeout=200)
    out = r.stdout
    t = float(out.rsplit("@@", 1)[1]) if "@@" in out else None
    m = re.search(r"solutions=(\d+)", out)
    live = re.search(r"actors: (\d+) live", out)
    return t, (int(m.group(1)) if m else None), (int(live.group(1)) if live else None)

def gc():
    subprocess.run(["curl", "-s", "-m", "60", BOARD + "/api/actors-gc?threshold_ms=0&dry=0"],
                   capture_output=True, timeout=70)

rows = []
for n in NS:
    b_full = gen(n, 0, n, "/tmp/_full.c")
    b_base = gen(n, 0, 0, "/tmp/_base.c")
    print(f"N={n}  生成C: 本番 {b_full}B / 素通し {b_base}B", flush=True)
    for i in range(REPS):
        time.sleep(GAP); tf, sol, live = post("/tmp/_full.c")
        time.sleep(GAP); gc()
        time.sleep(GAP); tb, _, _ = post("/tmp/_base.c")
        time.sleep(GAP); gc()
        ok = (sol == EXPECT[n])
        rows.append(dict(n=n, rep=i+1, t_full=tf, t_base=tb,
                         t_search=(tf-tb if (tf and tb) else None),
                         solutions=sol, expected=EXPECT[n], correct=ok, live=live))
        print(f"  rep{i+1}: 本番 {tf:.4f}s / 素通し {tb:.4f}s / 差 {tf-tb:+.4f}s "
              f"/ 解 {sol} ({'OK' if ok else 'NG'})", flush=True)

json.dump(rows, open("results.json", "w"), indent=1)
print("\n=== まとめ（全試行から）===")
print(f"{'N':>3} {'解':>5} {'正誤':>4} {'探索 最小':>10} {'中央値':>9} {'最大':>9} {'素通し中央値':>13}")
for n in NS:
    rs = [r for r in rows if r["n"] == n and r["t_search"] is not None]
    s = sorted(r["t_search"] for r in rs); b = sorted(r["t_base"] for r in rs)
    print(f"{n:>3} {rs[0]['solutions']:>5} {'全一致' if all(r['correct'] for r in rs) else '不一致':>4} "
          f"{s[0]*1000:>9.1f}ms {st.median(s)*1000:>8.1f}ms {s[-1]*1000:>8.1f}ms {st.median(b)*1000:>12.1f}ms")
