#!/usr/bin/env python3
"""HIL bridge: drone 3D rescue sim  <->  real Xinu WiFi MANET (Pi4/Pi3 ad-hoc).

The sim (served locally on http) calls  GET http://localhost:8090/manet?from=1&to=2
whenever UAV1 coordinates with UAV2.  This bridge turns that into a REAL WiFi
ad-hoc message: it drives the Pi4 over its serial console to ping the peer
node (10.0.0.<to>) across the IBSS cell, and reports delivered / RTT back so
the sim can visualize the real link.

Precondition (set up once):
  Pi3:  curl 'http://192.168.3.50:8080/wifi-adhoc?ssid=MANET&ch=6&n=2'
  Pi4 (serial):  wifi adhoc MANET 6 1
Then:  python3 bridge.py    and serve the sim:  (cd drone-hil && python3 -m http.server 8000)
Open:  http://localhost:8000/
"""
import http.server, socketserver, urllib.parse, subprocess, os, select, time, json, threading

DEV  = os.environ.get("PI4_SERIAL", "/dev/cu.usbserial-1120")
PORT = 8090
_lock = threading.Lock()

def serial_cmd(cmd, wait=5.0):
    """Send `cmd` (char-by-char, RX-FIFO-safe) to the Pi4 shell, collect output."""
    # ★ open FIRST, then stty: opening the cu device resets termios to 9600,
    #   so configure the already-open fd (same gotcha as `cat` capture).
    fd = os.open(DEV, os.O_RDWR | os.O_NONBLOCK)
    subprocess.run(["stty", "-f", DEV, "115200", "cs8", "-cstopb", "-parenb",
                    "-echo", "clocal", "-crtscts", "raw"], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        os.write(fd, b"\r"); time.sleep(0.3)
        try:
            while select.select([fd], [], [], 0)[0]: os.read(fd, 4096)  # flush
        except OSError: pass
        for ch in cmd:
            os.write(fd, ch.encode()); time.sleep(0.04)
        os.write(fd, b"\r")
        buf = b""; t0 = time.time()
        while time.time() - t0 < wait:
            if select.select([fd], [], [], 0.2)[0]:
                try: buf += os.read(fd, 4096)
                except OSError: pass
            if b"replies ***" in buf or b"timeout seq" in buf or b"no IP" in buf:
                break                              # ping finished -> stop early
        return buf.decode("ascii", "replace")
    finally:
        os.close(fd)

class H(http.server.BaseHTTPRequestHandler):
    def _hdr(self, code=200, ctype="application/json"):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", ctype)
        self.end_headers()
    def do_OPTIONS(self):
        self._hdr(204, "text/plain")
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path != "/manet":
            self._hdr(404, "text/plain"); self.wfile.write(b"use /manet?from=&to="); return
        to = int(q.get("to", ["2"])[0])
        with _lock:
            t0 = time.time()
            out = serial_cmd("wifi ping 10.0.0.%d 1" % to, 5.0)
            rtt = int((time.time() - t0) * 1000)
        delivered = ("reply seq=" in out) or (": 1/1" in out)
        self._hdr()
        self.wfile.write(json.dumps({
            "delivered": delivered, "rtt_ms": rtt, "hops": 1,
            "tail": out[-160:].replace("\r", " ")
        }).encode())
    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
if __name__ == "__main__":
    print("HIL bridge on http://localhost:%d   (Pi4 serial %s)" % (PORT, DEV))
    with socketserver.TCPServer(("127.0.0.1", PORT), H) as s:
        s.serve_forever()
