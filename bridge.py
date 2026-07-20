#!/usr/bin/env python3
"""HIL bridge v3: drone sim <-> real Xinu WiFi MANET (Pi4/Pi3 ad-hoc), over HTTP.

Serial is dead (adapter TX<->RX loopback), so both Xinu nodes are driven via
their HTTP remote-login `/shell` route.  Control stays on the wired LAN even
while the radios switch to ad-hoc.

  Pi4 = UAV1 = 10.0.0.1   @ http://192.168.3.100/shell
  Pi3 = UAV2 = 10.0.0.2   @ http://192.168.3.50:8080/shell

The Pi4's first WiFi command after a cold boot pulls the BCM43455 firmware,
which takes *minutes* and overruns any reasonable single HTTP wait.  So
/connect is ASYNCHRONOUS: it runs the adhoc+verify sequence in a background
thread and each /connect poll returns the live state.  The button polls every
few seconds and shows "接続中… Ns (step)" until up/failed — no spurious timeout.

Endpoints (CORS-open, for the localhost:8000 sim):
  GET /connect          start (if idle) the ad-hoc bring-up; return live state
  GET /connect?reset=1  force a fresh attempt even if one is in flight
  GET /manet?from=&to=  real WiFi ping Pi4->Pi3 -> {delivered,rtt_ms,hops}
  GET /status           quick reachability of both control planes
"""
import http.server, socketserver, urllib.parse, urllib.request, json, time, threading

PI4 = "http://192.168.3.100"          # /shell — wifi adhoc / wifi ping live here
PI3 = "http://192.168.3.50:8080"      # /shell
PORT = 8090

# Shared connect state, updated by the background worker, read by /connect polls.
_st = {"state": "idle", "step": "", "started": 0.0, "elapsed": 0,
       "rtt_ms": 0, "pi4_ok": False, "pi3_ok": False, "detail": ""}
_st_lock = threading.Lock()
_worker = None


def shell(base, cmd, timeout=60):
    """Run one Xinu shell command over the HTTP /shell route; return its output."""
    url = base + "/shell?cmd=" + urllib.parse.quote(cmd)
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read().decode("ascii", "replace")


def ping_ok(out):
    return ("reply seq=" in out) or ("1/1" in out)


def _set(**kw):
    with _st_lock:
        _st.update(kw)


def _connect_worker():
    _set(state="connecting", step="Pi4 ad-hoc (firmware…)", pi4_ok=False,
         pi3_ok=False, rtt_ms=0, detail="")
    parts = []
    try:
        # Pi4 -> node 1 (10.0.0.1).  Cold boot pulls firmware -> allow minutes.
        r4 = shell(PI4, "wifi adhoc MANET 6 1", timeout=600)
        pi4 = bool(r4.strip()) and "command not found" not in r4
        _set(pi4_ok=pi4, step="Pi3 ad-hoc")
        parts.append("pi4:" + r4[-60:])
        # Pi3 -> node 2 (10.0.0.2); wifi_adhoc() also starts the responder.
        r3 = shell(PI3, "wifi adhoc MANET 6 2", timeout=600)
        pi3 = bool(r3.strip()) and "command not found" not in r3
        _set(pi3_ok=pi3, step="verify ping")
        parts.append("pi3:" + r3[-60:])
        # verify: Pi4 pings Pi3 across the IBSS (retry — cell takes a moment).
        rp, rtt, ok = "", 0, False
        for _ in range(4):
            t0 = time.time()
            rp = shell(PI4, "wifi ping 10.0.0.2 1", timeout=30)
            rtt = int((time.time() - t0) * 1000)
            ok = ping_ok(rp)
            if ok:
                break
            time.sleep(1.5)
        parts.append("ping:" + rp[-60:])
        _set(state=("up" if ok else "failed"), rtt_ms=rtt, step="done",
             detail=" | ".join(parts).replace("\r", " ").replace("\n", " "))
    except Exception as e:
        parts.append("error: %s" % e)
        _set(state="failed", step="error",
             detail=" | ".join(parts).replace("\r", " ").replace("\n", " "))


def _snapshot():
    with _st_lock:
        s = dict(_st)
    if s["state"] == "connecting" and s["started"]:
        s["elapsed"] = int(time.time() - s["started"])
    return s


class H(http.server.BaseHTTPRequestHandler):
    def _hdr(self, code=200, ctype="application/json"):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", ctype)
        self.end_headers()

    def do_OPTIONS(self):
        self._hdr(204, "text/plain")

    def do_GET(self):
        global _worker
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == "/connect":
            reset = q.get("reset", ["0"])[0] == "1"
            with _st_lock:
                running = _st["state"] == "connecting"
            if (not running) and (reset or _st["state"] in ("idle", "up", "failed")):
                _set(state="connecting", started=time.time(), step="starting",
                     detail="", rtt_ms=0)
                _worker = threading.Thread(target=_connect_worker, daemon=True)
                _worker.start()
            self._hdr()
            self.wfile.write(json.dumps(_snapshot()).encode())
            return
        if u.path == "/manet":
            to = int(q.get("to", ["2"])[0])
            t0 = time.time()
            try:
                out = shell(PI4, "wifi ping 10.0.0.%d 1" % to, timeout=30)
            except Exception as e:
                out = "error %s" % e
            rtt = int((time.time() - t0) * 1000)
            self._hdr()
            self.wfile.write(json.dumps({
                "delivered": ping_ok(out), "rtt_ms": rtt, "hops": 1,
                "tail": out[-160:].replace("\r", " ")}).encode())
            return
        if u.path == "/disconnect":
            # Tear the MANET link down: both nodes leave the cell via `wifi off`
            # (WLC_DOWN + clear state).  Reversible — a later /connect re-UPs them.
            res = {"pi4_off": False, "pi3_off": False, "detail": ""}
            parts = []
            for key, base in (("pi4_off", PI4), ("pi3_off", PI3)):
                try:
                    r = shell(base, "wifi off", timeout=30)
                    res[key] = ("off" in r.lower()) or bool(r.strip())
                    parts.append(key + ":" + r[-50:])
                except Exception as e:
                    parts.append(key + " error:" + str(e))
            res["detail"] = " | ".join(parts).replace("\r", " ").replace("\n", " ")
            _set(state="idle", step="", rtt_ms=0, pi4_ok=False, pi3_ok=False)
            self._hdr()
            self.wfile.write(json.dumps(res).encode())
            return
        if u.path == "/status":
            s = {}
            for name, base in (("pi4", PI4), ("pi3", PI3)):
                try:
                    out = shell(base, "clear", timeout=6)
                    s[name] = bool(out)
                except Exception:
                    s[name] = False
            self._hdr()
            self.wfile.write(json.dumps(s).encode())
            return
        self._hdr(404, "text/plain")
        self.wfile.write(b"endpoints: /connect[?reset=1]  /manet?from=&to=  /status")

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
if __name__ == "__main__":
    print("HIL bridge v3 (async HTTP) on http://localhost:%d   Pi4=%s  Pi3=%s"
          % (PORT, PI4, PI3))
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as s:
        s.serve_forever()
