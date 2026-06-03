# drone-hil — NEXT SESSION handoff

3D レスキュー・ドローン・シミュレータ（M-006）× 実機 Xinu WiFi MANET の
HIL（Hardware-in-the-Loop）共シミュレーション。

## いまの状態（2026-06-03）

ブランチ `main`、最新コミットは AODV 進化分まで push 済み。

- **HIL ブリッジ**（`8f59a0a`）：sim の `dispatchUAV2()` を実 WiFi ping に写像
  （Pi4→Pi3 ad-hoc）。`bridge.py` が :8090 で serial↔HTTP。
- **MANET 通信レイヤ**（`f3147ba`）：レンジ円・動的リンク・UAV→地上局の
  マルチホップ可視化（最初は全知 BFS）。
- **リアクティブ AODV**（最新コミット）：全知 BFS を実機 AODV 相当に進化。
  経路キャッシュ → リンク切断検知 → **RREQ 再探索**（送信元から広がる白い
  リング）→ RREP、partition 時は buffering ログ。イベントログに
  `RREQ#n UAV1→GS … RREP: 2 hop [UAV1·R1·GS]` / `link broke → …` /
  `route lost — partitioned` を出力。ステータス行 `AODV … RREQ:n drop:m`。

実装は **元 sim を非改変**で `window.draw` をラップする追記 `<script>`
（`index.html` 末尾、コメント `MANET communication layer` のブロック）。
MANET スクリプト単体は `node --check` 構文 OK。

## 起動手順（リマインド）

```
# 実機 HIL を使う場合のみ（可視化だけなら不要）
Pi3 :  curl 'http://192.168.3.50:8080/wifi-adhoc?ssid=MANET&ch=6&n=2'
Pi4 :  (serial) wifi adhoc MANET 6 1
python3 bridge.py                 # :8090 serial<->HTTP（serial は単一所有：cat/screen を止める）

cd ~/projects/drone-hil
python3 -m http.server 8000       # local http（site44 の https から localhost を叩くと mixed-content でブロックされるため）
open http://localhost:8000/       # START を押す
```

可視化（MANET/AODV レイヤ）だけなら http.server :8000 + ブラウザだけで動く
（実機・bridge.py 不要）。右上 `MANET: ON/off` トグル。

## sim 側の使える globals（追記スクリプトから触れる）
`ctx`/`bgx`（canvas 2D context）, `W`/`H`（寸法）, `NODES`/`EDGES`/`N(id)`,
`getCSS(var)`, `uav1`/`uav2`（`.x`/`.y` 正規化座標, `.atId`/`.path`/`.step()`）,
`draw()`（関数宣言＝`window.draw` でラップ可）, `dijkstra`/`pathTo`,
`dispatchUAV2()`, `log(who,msg,cls)`（イベントログ：cls=`ev`/`u1`/`u2`）。
MANET レイヤのパラメータ：`R=0.30`（レンジ）, `RELAYS`（R1/R2/R3）,
地上局 GS = 避難所 A。

## 次の候補（未着手）
1. **実機リンク品質を反映**：bridge.py の実 RTT を該当リンクの色/太さへ。
   `/manet` は既に `{delivered,rtt_ms,hops}` を返す。
2. **store-and-carry-forward（DTN）**：partition 中はバッファ、再接続で配送
   アニメ（drop カウンタの隣に delivered/buffered）。
3. **3 ノード目を実機 AODV 中継**に。ただし Pi5（3 台目）は電源（5V/5A 27W
   USB-C PD）待ちでペンディング → 当面はシム内マルチホップで代替。

## 関連メモリ / 他リポ
- 実機 WiFi/MANET/AODV の全詳細：memory `project_xinu_rpi4_wifi.md`
  （Pi4 driver `~/projects/xinu-rpi4/device/wifi/wifi.c` の M0–M13）。
- Pi3 側：`~/projects/xinu-raz/xinu/apps/wifi.c`（adhoc+AODV 移植済）。
- Pi5（ペンディング）：`xhci.c` stub + Makefile `UART0_BASE=0x1F00030000`
  が未コミットで残置、SD は Pi OS に復元・`kernel_2712.img.xinu` 退避。
