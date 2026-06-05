import * as AST from "../ast.js";
import { Interpreter } from "../interpreter.js";

const SAMPLES = {
  pingpong: `class Pinger {
  method init() {
    print("Pinger starting");
    send ponger.ping();
  }
  method pong() {
    print("Pinger got pong");
    send sender.ping();
  }
}

class Ponger {
  method ping() {
    print("Ponger got ping");
    send sender.pong();
  }
}

var pinger = new Pinger();
var ponger = new Ponger();`,

  calc: `class Calc {
  method init() {
    print("Calc initialized");
  }

  method main() {
    print("waiting...");
    select {
      case add(a,b) -> {
        print("add received");
        reply(a + b);
      }
      timeout 3000 -> {
        print("timeout occurred");
      }
    }
    print("select finished");
  }
}

var calc = new Calc();
send calc.main();
send calc.add(3,4);`,

  rotate4: `class Line {
  var cx = 0.0;
  var cy = 0.0;
  var angle = 0.0;
  var len = 60.0;

  method init(startCx, startCy, startAngle) {
    cx = startCx;
    cy = startCy;
    angle = startAngle;
  }

  method rotate() {
    angle = angle + 3.0;
    var rad = angle * 3.14159 / 180.0;
    var dx = cos(rad) * len;
    var dy = sin(rad) * len;
    var x1 = cx - dx;
    var y1 = cy - dy;
    var x2 = cx + dx;
    var y2 = cy + dy;
    call canvas_line(x1, y1, x2, y2);
    call wait(32);
    send self.rotate();
  }
}

// Square vertices
var li1 = new Line(100.0, 100.0,   0.0);
var li2 = new Line(300.0, 100.0,  90.0);
var li3 = new Line(100.0, 300.0, 180.0);
var li4 = new Line(300.0, 300.0, 270.0);
send li1.rotate();
send li2.rotate();
send li3.rotate();
send li4.rotate();`,

  philosophers: `class Fork {
  var id       = 0;
  var taken    = 0;
  var waiter   = "";
  var waiterId = 0;

  method init(myId) { id = myId; }

  method take(reqId) {
    if (taken == 0) {
      taken = 1;
      call fork_held(id, reqId);
      send sender.fork_granted();
    } else {
      waiter   = sender;
      waiterId = reqId;
    }
  }

  method release() {
    if (waiter == "") {
      taken = 0;
      call fork_free(id);
    } else {
      send waiter.fork_granted();
      call fork_held(id, waiterId);
      waiter = "";
    }
  }
}

class Philosopher {
  var id       = 0;
  var lowFork  = "";
  var highFork = "";
  var hasLow   = 0;
  var eatCount = 0;

  method init(myId, lo, hi) {
    id = myId;
    lowFork  = lo;
    highFork = hi;
    send self.think();
  }

  method think() {
    call philo_state(id, 0);
    call wait(700);
    send self.hungry();
  }

  method hungry() {
    call philo_state(id, 1);
    hasLow = 0;
    send lowFork.take(id);
  }

  method fork_granted() {
    if (hasLow == 0) {
      hasLow = 1;
      send highFork.take(id);
    } else {
      send self.eat();
    }
  }

  method eat() {
    call philo_state(id, 2);
    eatCount = eatCount + 1;
    call wait(900);
    send self.eat_done();
  }

  method eat_done() {
    send lowFork.release();
    send highFork.release();
    send self.think();
  }
}

var fork0 = new Fork(0);
var fork1 = new Fork(1);
var fork2 = new Fork(2);
var fork3 = new Fork(3);
var fork4 = new Fork(4);

var p0 = new Philosopher(0, fork0, fork4);
var p1 = new Philosopher(1, fork0, fork1);
var p2 = new Philosopher(2, fork1, fork2);
var p3 = new Philosopher(3, fork2, fork3);
var p4 = new Philosopher(4, fork3, fork4);`,

  // Bounded Buffer with 15 slots + canvas viz. Built programmatically so we
  // can change BB_CAP in one place; the JS runtime has no array support so
  // each tail/head index needs its own `if` arm.
  bounded_buffer: (() => {
    const CAP = 15;
    const slotDecls = Array.from({length:CAP},(_,i)=>`  var s${i} = 0;`).join("\n");
    const tailIfs = (rhs) =>
      Array.from({length:CAP}, (_,i)=>`        if (tail == ${i}) { s${i} = ${rhs}; }`).join("\n");
    const headSends = () =>
      Array.from({length:CAP}, (_,i)=>`      if (head == ${i}) { send sender.got(s${i}); }`).join("\n");
    return `// Bounded Buffer (capacity 15) — canvas visualization + live-tunable speed.
// The Producer waits prod_speed() ms between sends; Consumer waits cons_speed() ms.
// Slide the Producer / Consumer bars above to see FULL / EMPTY blocking dynamically.
class Buffer {
  var cap   = ${CAP};
${slotDecls}
  var head  = 0;
  var tail  = 0;
  var count = 0;

  var pwaiter = "";
  var pitem   = 0;
  var cwaiter = "";

  method init() {
    call buf_init(${CAP});
  }

  method put(item) {
    if (cwaiter != "") {
      send sender.put_ok();
      send cwaiter.got(item);
      call buf_cstate("running");
      print("[BUF] passthrough put=" + item);
      cwaiter = "";
    } else {
      if (count == cap) {
        pwaiter = sender;
        pitem   = item;
        call buf_pstate("blocked");
        print("[BUF] FULL  -- queued put=" + item);
      } else {
${tailIfs("item")}
        call buf_set(tail, item);
        tail = tail + 1;
        if (tail == cap) { tail = 0; }
        count = count + 1;
        print("[BUF] put=" + item + "   count=" + count);
        send sender.put_ok();
      }
    }
  }

  method get() {
    if (count == 0) {
      cwaiter = sender;
      call buf_cstate("blocked");
      print("[BUF] EMPTY -- queued get");
    } else {
${headSends()}
      call buf_clear(head);
      head = head + 1;
      if (head == cap) { head = 0; }
      count = count - 1;
      print("[BUF] get   count=" + count);
      if (pwaiter != "") {
${tailIfs("pitem")}
        call buf_set(tail, pitem);
        tail = tail + 1;
        if (tail == cap) { tail = 0; }
        count = count + 1;
        call buf_pstate("running");
        print("[BUF] accepted queued put=" + pitem);
        send pwaiter.put_ok();
        pwaiter = "";
      }
    }
  }
}

class Producer {
  var id  = 0;
  var buf = "";
  var n   = 0;
  var max = 0;

  method init(myId, b, limit) {
    id = myId; buf = b; max = limit;
    send self.produce();
  }

  method produce() {
    if (n == max) {
      print("[P" + id + "] DONE");
    } else {
      n = n + 1;
      call buf_pn(n);
      print("[P" + id + "] -> put " + n);
      send buf.put(n);
    }
  }

  method put_ok() {
    call buf_pstate("running");
    call wait(prod_speed());
    send self.produce();
  }
}

class Consumer {
  var id    = 0;
  var buf   = "";
  var taken = 0;
  var max   = 0;

  method init(myId, b, limit) {
    id = myId; buf = b; max = limit;
    send buf.get();
  }

  method got(item) {
    taken = taken + 1;
    call buf_cn(taken);
    call buf_cstate("running");
    print("[C" + id + "] got " + item + "   (total=" + taken + ")");
    if (taken == max) {
      print("[C" + id + "] DONE");
    } else {
      call wait(cons_speed());
      send self.do_get();
    }
  }

  method do_get() {
    send buf.get();
  }
}

var buf = new Buffer();
var p0  = new Producer(0, buf, 9999);
var c0  = new Consumer(0, buf, 9999);`;
  })(),

  // (legacy 4-slot version kept here for reference, unused)
  _bounded_buffer_old: `// Bounded Buffer with right-side canvas visualization.
// Calls buf_* primitives to update the slot/state display on canvas.
class Buffer {
  var cap   = 4;
  var s0    = 0;
  var s1    = 0;
  var s2    = 0;
  var s3    = 0;
  var head  = 0;
  var tail  = 0;
  var count = 0;

  var pwaiter = "";
  var pitem   = 0;
  var cwaiter = "";

  method init() {
    call buf_init(4);
  }

  method put(item) {
    if (cwaiter != "") {
      send sender.put_ok();
      send cwaiter.got(item);
      call buf_cstate("running");
      print("[BUF] passthrough put=" + item);
      cwaiter = "";
    } else {
      if (count == cap) {
        pwaiter = sender;
        pitem   = item;
        call buf_pstate("blocked");
        print("[BUF] FULL  -- queued put=" + item);
      } else {
        if (tail == 0) { s0 = item; }
        if (tail == 1) { s1 = item; }
        if (tail == 2) { s2 = item; }
        if (tail == 3) { s3 = item; }
        call buf_set(tail, item);
        tail = tail + 1;
        if (tail == cap) { tail = 0; }
        count = count + 1;
        print("[BUF] put=" + item + "   count=" + count);
        send sender.put_ok();
      }
    }
  }

  method get() {
    if (count == 0) {
      cwaiter = sender;
      call buf_cstate("blocked");
      print("[BUF] EMPTY -- queued get");
    } else {
      if (head == 0) { send sender.got(s0); }
      if (head == 1) { send sender.got(s1); }
      if (head == 2) { send sender.got(s2); }
      if (head == 3) { send sender.got(s3); }
      call buf_clear(head);
      head = head + 1;
      if (head == cap) { head = 0; }
      count = count - 1;
      print("[BUF] get   count=" + count);
      if (pwaiter != "") {
        if (tail == 0) { s0 = pitem; }
        if (tail == 1) { s1 = pitem; }
        if (tail == 2) { s2 = pitem; }
        if (tail == 3) { s3 = pitem; }
        call buf_set(tail, pitem);
        tail = tail + 1;
        if (tail == cap) { tail = 0; }
        count = count + 1;
        call buf_pstate("running");
        print("[BUF] accepted queued put=" + pitem);
        send pwaiter.put_ok();
        pwaiter = "";
      }
    }
  }
}

class Producer {
  var id  = 0;
  var buf = "";
  var n   = 0;
  var max = 0;

  method init(myId, b, limit) {
    id = myId; buf = b; max = limit;
    send self.produce();
  }

  method produce() {
    if (n == max) {
      print("[P" + id + "] DONE");
    } else {
      n = n + 1;
      call buf_pn(n);
      print("[P" + id + "] -> put " + n);
      send buf.put(n);
    }
  }

  method put_ok() {
    call buf_pstate("running");
    call wait(120);
    send self.produce();
  }
}

class Consumer {
  var id    = 0;
  var buf   = "";
  var taken = 0;
  var max   = 0;

  method init(myId, b, limit) {
    id = myId; buf = b; max = limit;
    send buf.get();
  }

  method got(item) {
    taken = taken + 1;
    call buf_cn(taken);
    call buf_cstate("running");
    print("[C" + id + "] got " + item + "   (total=" + taken + ")");
    if (taken == max) {
      print("[C" + id + "] DONE");
    } else {
      call wait(420);
      send self.do_get();
    }
  }

  method do_get() {
    send buf.get();
  }
}

var buf = new Buffer();
var p0  = new Producer(0, buf, 12);
var c0  = new Consumer(0, buf, 12);`,

  cooperative: `// 3-role AI cooperation with now / future / await.
// AI provider is the browser's mock; it echoes the prompt prefix.
class Planner {
  method plan(q) {
    var sketch = ai_call_with_system(
      "You are a planner. Output a 1-line plan, no preamble.",
      q);
    reply(sketch);
  }
}

class Solver {
  method solve(plan) {
    var ans = ai_call_with_system(
      "You are a solver. Apply the given plan and answer concisely.",
      plan);
    reply(ans);
  }
}

class Reviewer {
  method review(ans) {
    var verdict = ai_call_with_system(
      "You are a reviewer. Reply with 'OK: <reason>' or 'NG: <reason>' only.",
      ans);
    reply(verdict);
  }
  method brief() {
    var b = ai_call("In one short sentence: what does a code reviewer look for?");
    reply(b);
  }
}

var planner  = new Planner();
var solver   = new Solver();
var reviewer = new Reviewer();

var question = "What is 12 * 11? Show only the number.";

// 1) plan synchronously
var plan = now planner.plan(question);
print("[plan] " + plan);

// 2) solve and reviewer-brief in parallel (future)
var fut_ans   = future solver.solve(plan);
var fut_brief = future reviewer.brief();

var answer = await fut_ans;
print("[answer] " + answer);

var brief = await fut_brief;
print("[reviewer brief] " + brief);

// 3) final review synchronously
var verdict = now reviewer.review(answer);
print("[verdict] " + verdict);`,
};

window.addEventListener("DOMContentLoaded", () => {
  const parser = window.parser;

  // Flex column on body so the H-resizer can re-allocate space between the
  // upper area (console + canvas/chat) and the lower textarea (source code).
  document.body.style.margin = "0";
  document.body.style.height = "100vh";
  document.body.style.display = "flex";
  document.body.style.flexDirection = "column";

  document.body.innerHTML = `
    <div id="bar" style="padding:10px;background:#222;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex-shrink:0;">
      <button id="btnRun">▶ run</button>
      <button id="btnStop">■ stop</button>
      <button id="btnParseOnly">parse only</button>
      <button id="btnClear">clear</button>
      <span style="color:#888;margin-left:8px;">sample:</span>
      <button id="btnLoadPingPong">PingPong</button>
      <button id="btnLoadCalc">Calc (select)</button>
      <button id="btnLoadRotate">Rotate4Lines</button>
      <button id="btnLoadPhilos">5 Philosophers</button>
      <button id="btnLoadBuf">Bounded Buffer</button>
      <button id="btnLoadCoop">Cooperative (now/future/await)</button>
      <span style="margin-left:auto;"></span>
      <button id="btnGotoSolve"
              title="協調問題解決ワークスペース (Console+Chat 一体) へ移動"
              style="background:#1a3a2a;color:#afe;border:1px solid #486;">
        🤝 協調問題解決へ
      </button>
      <button id="btnGotoChat"
              title="AI Cooperative Chat (吹き出しビュー) へ移動"
              style="background:#3a1a3a;color:#fac;border:1px solid #846;">
        💬 Chat ビューへ
      </button>
    </div>

    <div id="speedBar" style="padding:6px 12px;background:#1a1a2a;border-bottom:1px solid #333;display:none;gap:14px;align-items:center;flex-wrap:wrap;font-size:0.85rem;color:#aaa;flex-shrink:0;">
      <span style="color:#88c;">Bounded Buffer 入出力速度 (running 中も即反映):</span>
      <label style="display:flex;align-items:center;gap:6px;color:#66ccff;">
        入力 (Producer)
        <input id="prodSpeed" type="range" min="40" max="2000" step="20" value="120"
               style="accent-color:#66ccff;">
        <span id="prodLabel" style="min-width:54px;text-align:right;">120 ms</span>
      </label>
      <label style="display:flex;align-items:center;gap:6px;color:#ffcc66;">
        出力 (Consumer)
        <input id="consSpeed" type="range" min="40" max="2000" step="20" value="420"
               style="accent-color:#ffcc66;">
        <span id="consLabel" style="min-width:54px;text-align:right;">420 ms</span>
      </label>
    </div>

    <div id="mainArea" style="flex:1;display:flex;min-height:120px;overflow:hidden;">
      <div id="consoleOut"
           style="flex:1;min-width:120px;overflow:auto;padding:12px;white-space:pre-wrap;
                  background:#000;color:#0f0;font-family:monospace;"></div>
      <div id="vResizer"
           title="ドラッグで左右の幅を変更"
           style="width:6px;background:#333;cursor:col-resize;flex-shrink:0;"></div>
      <div id="rightPanel" style="display:flex;flex-direction:column;width:66vw;flex-shrink:0;min-width:200px;">
        <canvas id="canvas" width="520" height="260" style="background:#0a0a1a;display:block;"></canvas>
        <div id="chat" style="flex:1;overflow-y:auto;padding:10px;background:#16162a;
                              border-top:1px solid #333;display:flex;flex-direction:column;gap:8px;
                              font-family:-apple-system,'Hiragino Sans',sans-serif;"></div>
      </div>
    </div>

    <div id="hResizer"
         title="ドラッグで上下の高さを変更"
         style="height:6px;background:#333;cursor:row-resize;flex-shrink:0;"></div>

    <style>
      #chat .row { display:flex; gap:8px; align-items:flex-start; }
      #chat .row.right { flex-direction: row-reverse; }
      #chat .avatar {
        width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;
        font-weight:bold;font-size:0.85rem;flex-shrink:0;
      }
      #chat .avatar.user     { background:#2a2a3d; color:#ddd; }
      #chat .avatar.planner  { background:#1e3a5f; color:#aed7ff; }
      #chat .avatar.solver   { background:#1e4d35; color:#a8e9c4; }
      #chat .avatar.reviewer { background:#5c3a16; color:#ffd8a8; }
      #chat .avatar.verdict  { background:#5c2030; color:#ffb3c0; }
      #chat .stack { display:flex; flex-direction:column; min-width:0; flex:1; }
      #chat .meta  { font-size:0.68rem; color:#888; margin-bottom:3px; display:flex; gap:5px; align-items:center; }
      #chat .meta .stage { background:#2a2a45; color:#888; padding:1px 5px; border-radius:3px; font-size:0.65rem; }
      #chat .bubble {
        max-width:85%; padding:8px 10px; border-radius:10px;
        font-size:0.82rem; line-height:1.35; word-break:break-word; white-space:pre-wrap;
        animation: bub-fade 0.3s ease-out;
      }
      #chat .bubble.user     { background:#2a2a3d; color:#ddd; border-top-right-radius:3px; }
      #chat .bubble.planner  { background:#1e3a5f; color:#aed7ff; border-top-left-radius:3px; }
      #chat .bubble.solver   { background:#1e4d35; color:#a8e9c4; border-top-left-radius:3px; }
      #chat .bubble.reviewer { background:#5c3a16; color:#ffd8a8; border-top-left-radius:3px; }
      #chat .bubble.verdict  { background:#5c2030; color:#ffb3c0; border-top-left-radius:3px; }
      #chat .placeholder { color:#666; font-size:0.78rem; text-align:center; padding:14px; }
      @keyframes bub-fade { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
    </style>

    <div id="inputRow"
         style="display:flex;gap:8px;align-items:center;padding:10px;
                background:#181818;border-top:1px solid #333;">
      <span style="color:#0f0;font-family:monospace;font-weight:bold;">AIPL&gt;</span>
      <input id="cmd" type="text" placeholder="single command"
             style="flex:1;padding:8px;background:#222;color:#fff;border:1px solid #555;font-family:monospace;">
      <button id="runCmdBtn"
              style="padding:8px 12px;background:#333;color:#fff;border:1px solid #666;cursor:pointer;">Run</button>
    </div>

    <textarea id="src"
              style="width:100%;height:260px;background:#111;color:#fff;
                     font-family:monospace;padding:8px;box-sizing:border-box;flex-shrink:0;">${SAMPLES.pingpong}</textarea>
  `;

  // ---- Drag-to-resize: vertical (console / right panel) and
  //                       horizontal (main area / source textarea) ----
  function attachVResizer(handle, panel, container) {
    let dragging = false, startX = 0, startW = 0;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const containerW = container.getBoundingClientRect().width;
      const newW = Math.max(160, Math.min(containerW - 200, startW - dx));
      panel.style.width = newW + "px";
    });
    document.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    });
  }

  function attachHResizer(handle, lowerEl) {
    let dragging = false, startY = 0, startH = 0;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      startY = e.clientY;
      startH = lowerEl.getBoundingClientRect().height;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      const newH = Math.max(60, Math.min(window.innerHeight - 240, startH - dy));
      lowerEl.style.height = newH + "px";
    });
    document.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    });
  }

  attachVResizer(
    document.getElementById("vResizer"),
    document.getElementById("rightPanel"),
    document.getElementById("mainArea")
  );
  attachHResizer(
    document.getElementById("hResizer"),
    document.getElementById("src")
  );

  const consoleOut = document.getElementById("consoleOut");
  const canvas     = document.getElementById("canvas");
  const src        = document.getElementById("src");
  const cmdInput   = document.getElementById("cmd");
  const chat       = document.getElementById("chat");

  // ---- Chat-bubble side panel (driven by [plan]/[answer]/... labels) ----
  const ROLE_MAP = {
    "[plan]":           { kind: "planner",  who: "Planner",  emoji: "🧠", stage: "now planner.plan" },
    "[answer]":         { kind: "solver",   who: "Solver",   emoji: "⚙️", stage: "future + await solver.solve" },
    "[reviewer brief]": { kind: "reviewer", who: "Reviewer", emoji: "📋", stage: "future + await reviewer.brief" },
    "[verdict]":        { kind: "verdict",  who: "Reviewer", emoji: "✅", stage: "now reviewer.review" },
  };
  function chatPlaceholder() {
    chat.innerHTML = `<div class="placeholder">Cooperative サンプルを ▶ run すると、Planner / Solver / Reviewer の発話がここに吹き出しで表示されます。</div>`;
  }
  function clearChat() { chat.innerHTML = ""; }
  function addBubble({ kind, who, emoji, stage, text, side = "left" }) {
    if (chat.querySelector(".placeholder")) clearChat();
    const row = document.createElement("div");
    row.className = "row" + (side === "right" ? " right" : "");
    const avatar = document.createElement("div");
    avatar.className = "avatar " + kind;
    avatar.textContent = emoji;
    row.appendChild(avatar);
    const stack = document.createElement("div");
    stack.className = "stack";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<strong>${who}</strong>` + (stage ? `<span class="stage">${stage}</span>` : "");
    stack.appendChild(meta);
    const bubble = document.createElement("div");
    bubble.className = "bubble " + kind;
    bubble.textContent = text;
    stack.appendChild(bubble);
    row.appendChild(stack);
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
  }
  function maybeRouteToChat(line) {
    const s = String(line || "");
    for (const [label, role] of Object.entries(ROLE_MAP)) {
      if (s.startsWith(label)) {
        addBubble({ ...role, text: s.slice(label.length).trimStart() });
        return true;
      }
    }
    return false;
  }
  chatPlaceholder();

  let history = [], historyIndex = -1;
  let activeTimers = [];
  let running = false;

  // Wrap setTimeout so we can cancel all actor threads on Stop
  const _origSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = function(fn, ms, ...rest) {
    const id = _origSetTimeout(fn, ms, ...rest);
    if (running) activeTimers.push(id);
    return id;
  };

  function stopAll() {
    running = false;
    activeTimers.forEach(id => clearTimeout(id));
    activeTimers = [];
  }

  function appendConsole(line) {
    if (line === undefined || line === null) return;
    // Cooperative-pattern outputs ([plan]/[answer]/[reviewer brief]/[verdict])
    // are routed into the right-side chat panel as bubbles. Everything else
    // still goes into the green console pane on the left.
    if (maybeRouteToChat(line)) return;
    const s = String(line);
    consoleOut.textContent += s;
    if (!s.endsWith("\n")) consoleOut.textContent += "\n";
    consoleOut.scrollTop = consoleOut.scrollHeight;
  }

  function clearConsole() { consoleOut.textContent = ""; chatPlaceholder(); }

  function closeConsoleWindow() {
    if (!window.confirm("Close this console?")) return;
    appendConsole("Bye!");
    setTimeout(() => window.close(), 200);
  }

  if (!parser) {
    appendConsole("[ERROR] window.parser is not available.");
    return;
  }
  parser.yy = AST;

  // Slider state & wiring (Bounded Buffer producer/consumer speeds).
  // The values are pushed onto the active Runtime so prod_speed() /
  // cons_speed() builtins return the latest value on every wait().
  let speedProd = 120, speedCons = 420;
  let activeInterp = null;
  const prodSlider = document.getElementById("prodSpeed");
  const consSlider = document.getElementById("consSpeed");
  const prodLabel  = document.getElementById("prodLabel");
  const consLabel  = document.getElementById("consLabel");
  function applySpeeds() {
    speedProd = parseInt(prodSlider.value, 10);
    speedCons = parseInt(consSlider.value, 10);
    prodLabel.textContent = speedProd + " ms";
    consLabel.textContent = speedCons + " ms";
    if (activeInterp) {
      activeInterp.runtime._prodSpeed = speedProd;
      activeInterp.runtime._consSpeed = speedCons;
    }
  }
  prodSlider.addEventListener("input", applySpeeds);
  consSlider.addEventListener("input", applySpeeds);
  applySpeeds();

  // Show the speed bar only when the textarea looks like a Bounded Buffer
  // program — detected by the BB-specific builtins / markers. Re-evaluated
  // after each sample-loader click and on manual edits to the source.
  const speedBar = document.getElementById("speedBar");
  function updateSpeedBarVisibility() {
    const t = src.value || "";
    const isBB = /buf_init\s*\(|prod_speed\s*\(\s*\)|cons_speed\s*\(\s*\)/.test(t);
    speedBar.style.display = isBB ? "flex" : "none";
  }
  src.addEventListener("input", updateSpeedBarVisibility);
  updateSpeedBarVisibility();

  function makeInterpreter() {
    const interp = new Interpreter(appendConsole);
    interp.setCanvas(canvas);
    interp.runtime._prodSpeed = speedProd;
    interp.runtime._consSpeed = speedCons;
    activeInterp = interp;
    return interp;
  }

  function runSource(code) {
    stopAll();
    clearConsole();
    appendConsole(">>> run");
    // If this looks like the cooperative pattern, surface the user's question
    // as the first chat bubble so the right-side panel reads as a real chat.
    const m = code.match(/var\s+question\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/);
    if (m && /\[plan\]/.test(code)) {
      addBubble({
        kind: "user", who: "You", emoji: "👤", stage: "input",
        text: m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
        side: "right",
      });
    }
    running = true;
    try {
      const ast = parser.parse(code);
      appendConsole("[parse ok]");
      makeInterpreter().runProgram(ast);
    } catch (e) {
      running = false;
      appendConsole("[ERROR] " + e);
    }
  }

  function parseOnly(code) {
    stopAll();
    clearConsole();
    appendConsole(">>> parse");
    try {
      const ast = parser.parse(code);
      appendConsole("[parse ok]");
      appendConsole(JSON.stringify(ast, null, 2));
    } catch (e) {
      appendConsole("[ERROR] " + e);
    }
  }

  function runSingleCommand(cmd) {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    if (trimmed === "exit" || trimmed === "quit") { closeConsoleWindow(); return; }
    if (trimmed === "help") {
      appendConsole("Commands: help, exit, stop");
      appendConsole("Or type any AIPL statement.");
      return;
    }
    if (trimmed === "stop") { stopAll(); appendConsole("[stopped]"); return; }

    appendConsole("AIPL> " + trimmed);
    try {
      const wrapped = trimmed.endsWith(";") ? trimmed : trimmed + ";";
      const ast = parser.parse(wrapped);
      appendConsole("[parse ok]");
      running = true;
      makeInterpreter().runProgram(ast);
    } catch (e) {
      running = false;
      appendConsole("[ERROR] " + e);
    }
  }

  document.getElementById("btnRun").addEventListener("click", () => runSource(src.value));
  document.getElementById("btnStop").addEventListener("click", () => { stopAll(); appendConsole("[stopped]"); });
  document.getElementById("btnParseOnly").addEventListener("click", () => parseOnly(src.value));
  document.getElementById("btnClear").addEventListener("click", () => { clearConsole(); cmdInput.focus(); });
  // Sample loaders — also re-evaluate speed-bar visibility (input event
  // doesn't fire for programmatic value changes, so trigger it manually).
  function loadSample(text) { src.value = text; updateSpeedBarVisibility(); }
  document.getElementById("btnLoadPingPong").addEventListener("click", () => loadSample(SAMPLES.pingpong));
  document.getElementById("btnLoadCalc").addEventListener("click",     () => loadSample(SAMPLES.calc));
  document.getElementById("btnLoadRotate").addEventListener("click",   () => loadSample(SAMPLES.rotate4));
  document.getElementById("btnLoadPhilos").addEventListener("click",   () => loadSample(SAMPLES.philosophers));
  document.getElementById("btnLoadBuf").addEventListener("click",      () => loadSample(SAMPLES.bounded_buffer));
  document.getElementById("btnLoadCoop").addEventListener("click",     () => loadSample(SAMPLES.cooperative));
  document.getElementById("btnGotoChat").addEventListener("click", () => {
    // Open the chat-bubble view in a new tab so the console session stays put.
    window.open("/cooperative_chat.html", "_blank");
  });
  document.getElementById("btnGotoSolve").addEventListener("click", () => {
    // Open the cooperative-problem-solving workspace (console + chat + source).
    window.open("/cooperative_solve.html", "_blank");
  });

  document.getElementById("runCmdBtn").addEventListener("click", () => {
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    history.push(cmd); historyIndex = history.length;
    runSingleCommand(cmd);
    cmdInput.value = ""; cmdInput.focus();
  });

  cmdInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { document.getElementById("runCmdBtn").click(); return; }
    if (ev.ctrlKey && (ev.key === "d" || ev.key === "D")) { ev.preventDefault(); closeConsoleWindow(); return; }
    if (ev.key === "ArrowUp") {
      if (!history.length) return;
      historyIndex = Math.max(0, historyIndex - 1);
      cmdInput.value = history[historyIndex] || ""; ev.preventDefault();
    }
    if (ev.key === "ArrowDown") {
      if (!history.length) return;
      historyIndex = Math.min(history.length, historyIndex + 1);
      cmdInput.value = historyIndex === history.length ? "" : history[historyIndex];
      ev.preventDefault();
    }
  });

  appendConsole("AIPL Browser Console — actor threads edition");
  appendConsole("Each actor runs as an independent setTimeout thread.");
  appendConsole("");
  appendConsole("Samples: PingPong / Calc(select) / Rotate4Lines / 5 Philosophers / Bounded Buffer");
  appendConsole("Demos:   /rotate4lines.html  /philosophers.html  /bounded_buffer.html");
  appendConsole("Press ▶ run to execute.");
  appendConsole("");
  cmdInput.focus();
});
