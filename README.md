# Drone 3D Rescue Sim × real Xinu WiFi MANET (HIL)

Hardware-in-the-loop: the M-006 UAV disaster-evacuation simulator's
**UAV1→UAV2 coordination** (`dispatchUAV2`) is mapped to a **real WiFi ad-hoc
(IBSS) MANET message** between two Xinu nodes:

  - **UAV1 = Pi4**  (10.0.0.1, driven over serial `/dev/cu.usbserial-1120`)
  - **UAV2 = Pi3**  (10.0.0.2, responder in the ad-hoc cell)

```
[browser sim @localhost:8000] --fetch--> [bridge.py @localhost:8090]
        dispatchUAV2()                         |
        wrapped -> hilSend(1,2)                 | writes "wifi ping 10.0.0.2 1"
                                                v  to the Pi4 serial console
                                         [Pi4] --real WiFi IBSS--> [Pi3]
        badge/log <-- {delivered,rtt} <--- reply seq=0 (1/1)
```

## Files
- `index.html` — the live sim (fetched from lecture.site44.com/drone) + an
  appended `<script>` that wraps `dispatchUAV2` and shows a MANET HIL badge.
- `bridge.py` — HTTP :8090; `/manet?from=1&to=2` drives the Pi4 serial to ping
  the peer over the IBSS and returns `{delivered,rtt_ms,hops}` (CORS-open).

## Run
1. Put both nodes in the same ad-hoc cell (once):
   - Pi3:  `curl 'http://192.168.3.50:8080/wifi-adhoc?ssid=MANET&ch=6&n=2'`
   - Pi4 (serial):  `wifi adhoc MANET 6 1`
2. `python3 bridge.py`                       # serial<->HTTP bridge (:8090)
3. `python3 -m http.server 8000`             # serve the sim (local http = no CORS/mixed-content)
4. Open `http://localhost:8000/`, press **START**.
   Each UAV2 dispatch fires a real WiFi ping Pi4→Pi3; the bottom-right badge
   and the NET event-log lines show the real delivery + RTT.

## Notes / next
- The sim is `https` on site44; browsers block its fetch to `http://localhost`.
  Running the sim from **local http** (step 3) avoids the mixed-content/CORS block.
- Today this maps coordination -> a real ping. Next: send the *actual target
  point* as a MANET payload (UDP), and (with a 3rd node + MAC filter) route it
  multi-hop via AODV so the sim visualizes the real multi-hop path.
- Serial is single-owner: stop any `cat`/`screen` on the Pi4 serial before `bridge.py`.
