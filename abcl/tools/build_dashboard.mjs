// build_dashboard.mjs —— Py-I のライブ・ダッシュボード（/actors）の **JS-I 版**を、
// サーバー不要の 1 枚 HTML にまとめる。
//
//   node tools/build_dashboard.mjs [出力先]      既定: ./js_dashboard.html
//
// Py-I 版は `python3 src/python-aipl/aipl_main.py --dashboard 8899 prog.aipl` が
// 立てた HTTP サーバーが AIPL を実行し、ブラウザは /api/actors などを polling する。
// こちらは **ブラウザの中の AIPL 処理系(JS-I)が同じ .aipl を実行する**。
// 画面（表・可視化・コンソール・ソース表示）は Py-I 版の HTML をそのまま使い、
// fetch していた API だけを、同じ形の JSON を返すローカル関数に差し替える。
//
//   ・tools/dashboard_base.html … Py-I 版 /actors の写し（見た目の出典）
//   ・JS-I（../）             … parser(jison) + ast/types/infer/typecheck/runtime/interpreter
//   ・PROG_DIR の .aipl        … プログラム選択に載せる（既定は dining/ring/buffer）
//
// file:// では相対 import が CORS で禁止されるので、モジュールは文字列で持ち、
// 実行時に Blob URL 化して依存順に import する。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const JSI = join(HERE, "..");
const OUT = process.argv[2] || join(JSI, "js_dashboard.html");
const PROG_DIR = process.env.PROG_DIR
  || join(process.env.HOME, "test-bed/aios-claude/aice-pi-evolution/experiments/2026-05-27_dining_mac_xinu");
const read = (p) => readFileSync(p, "utf8");

// ---- JS-I のモジュール（依存の浅い順）--------------------------------------
const MODULES = [
  { id: "types",       src: read(join(JSI, "types.js")),       map: {} },
  { id: "infer",       src: read(join(JSI, "infer.js")),       map: { "./types.js": "types" } },
  { id: "typecheck",   src: read(join(JSI, "typecheck.js")),   map: { "./infer.js": "infer", "./types.js": "types" } },
  { id: "runtime",     src: read(join(JSI, "runtime.js")),     map: {} },
  { id: "ast",         src: read(join(JSI, "ast.js")),         map: {} },
  { id: "interpreter", src: read(join(JSI, "interpreter.js")), map: { "./runtime.js": "runtime", "./typecheck.js": "typecheck" } },
];
for (const m of MODULES) {
  for (const [spec, dep] of Object.entries(m.map)) {
    const before = m.src;
    for (const q of ["'", '"']) m.src = m.src.split(q + spec + q).join(q + `__MOD:${dep}__` + q);
    if (m.src === before) throw new Error(`${m.id}: import '${spec}' が見つからない`);
  }
  const left = m.src.match(/^\s*(?:import|export)[^\n]*from\s+['"](?!__MOD:)[^'"]+['"]/gm);
  if (left) throw new Error(`${m.id}: 未解決の import → ${left.join(", ")}`);
}
const PARSER = read(join(JSI, "parser/parser.js"));

// ---- 載せるプログラム --------------------------------------------------------
// リモート（Xinu 実機）を前提にするものは、サーバー無しでは動かないので外す。
const WANT = [
  { file: "local_diners.aipl",   label: "Dining Philosophers (local, 5)" },
  { file: "ring_demo.aipl",      label: "Token ring (local, 4)" },
  { file: "bounded_buffer.aipl", label: "Bounded buffer (local, 2 producers + 2 consumers)" },
];
const PROGRAMS = [];
for (const w of WANT) {
  const p = join(PROG_DIR, w.file);
  if (!existsSync(p)) { console.warn(`(skip) ${p} が無い`); continue; }
  PROGRAMS.push({ key: w.file, label: w.label, path: p, source: read(p) });
}
if (!PROGRAMS.length) throw new Error(`プログラムが 1 つも見つからない: ${PROG_DIR}`);

// ---- Py-I 版のページを土台に、API 呼び出しだろを差し替える -------------------
let html = read(join(HERE, "dashboard_base.html"));
const swap = (s, from, to) => {
  if (!s.includes(from)) throw new Error("差し替え箇所が見つからない: " + from.slice(0, 60));
  return s.replace(from, () => to);
};

html = swap(html, "<title>Py-I — AIPL actors</title>",
  "<title>JS-I — AIPL actors (standalone)</title>");
html = swap(html, "<h1>Py-I &mdash; AIPL interpreter (live)</h1>",
  '<button id="langBtn" type="button" style="position:absolute;top:14px;right:16px;font-family:inherit;'
  + 'font-size:13px;padding:5px 12px;border:1px solid #3b4757;border-radius:5px;background:#1a2430;'
  + 'color:#d8dee9;cursor:pointer">日本語</button>\n'
  + '<h1 id="t_h1">JS-I &mdash; AIPL interpreter (live, in this page)</h1>\n'
  + '<div class="meta" id="t_sub">The same screen as the Py-I dashboard '
  + '(<code>--dashboard PORT</code> &rarr; <code>/actors</code>), driven by '
  + '<b>the AIPL runtime inside this page (JS-I)</b>. No server, no network.</div>');
html = swap(html, '<h2>Visualization</h2>', '<h2 id="t_viz">Visualization</h2>');
html = swap(html, '<h2>Running actors</h2>', '<h2 id="t_actors">Running actors</h2>');
html = swap(html, '<h2>Console &mdash; print() output</h2>', '<h2 id="t_console">Console &mdash; print() output</h2>');
html = swap(html, '<h2>Current program</h2>', '<h2 id="t_program">Current program</h2>');
html = swap(html, '<label for="progsel">Program:</label>', '<label for="progsel" id="t_proglabel">Program:</label>');
html = swap(html, "<body>", '<body style="position:relative">');

// 元のスクリプト（API を fetch する部分）を、ローカルの処理系を叩く形へ。
const apiStart = html.indexOf("<script>\nfunction esc(");
const apiEnd = html.indexOf("</script></body></html>");
if (apiStart < 0 || apiEnd < 0) throw new Error("スクリプト部分が見つからない");
const clientJs = html.slice(apiStart + "<script>\n".length, apiEnd);

// 描画（drawViz / drawBuffer / philColor / …）は そのまま使い、
// fetch していた 6 つの関数だけを置き換える。
// ★ 位置は毎回いまの文字列で数え直す。元の文字列の位置を使い回すと、
//    ひとつ消したあとの位置がずれて、関数の途中で切ってしまう（実際に踏んだ）。
const cut = (text, name) => {
  const i = text.indexOf(`async function ${name}(`);
  if (i < 0) throw new Error(`関数が見つからない: ${name}`);
  let depth = 0;
  for (let k = text.indexOf("{", i); k < text.length; k++) {
    if (text[k] === "{") depth++;
    else if (text[k] === "}" && --depth === 0) return [i, k + 1];
  }
  throw new Error(`関数の終わりが見つからない: ${name}`);
};
let js = clientJs;
for (const fn of ["loadProg", "ctl", "pushSpeed", "tick", "conTick", "loadPrograms", "switchProgram"]) {
  const [a, b] = cut(js, fn);
  js = js.slice(0, a) + `/* ${fn}: JS-I 版に差し替え（末尾を参照） */` + js.slice(b);
}
js = js.replace("let conSince=0;", "");          // エンジン側で宣言する
js = js.replace("function setState(", "var setState = function(");   // 言語版で包めるように
js = js.replace("loadPrograms(); loadProg(); tick(); conTick();", "");
js = js.replace(
  "setInterval(tick,1000); setInterval(loadProg,5000); setInterval(conTick,500); setInterval(loadPrograms,5000);",
  "");

const engine = `
// ===================== JS-I エンジン =====================
// Py-I 版の /api/* と同じ形の値を、ブラウザの中の処理系から作る。
const PROGRAMS = ${JSON.stringify(PROGRAMS.map((p) => ({ key: p.key, label: p.label, path: p.path, source: p.source })))};
const SOURCES = ${JSON.stringify(MODULES.map((m) => [m.id, m.src]))};
const urls = {};
for (const [id, src0] of SOURCES) {
  const src = src0.replace(/__MOD:([a-z_]+)__/g, (_, d) => urls[d]);
  urls[id] = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
}

let AST = null, Interpreter = null;      // JS-I のモジュール
let interp = null, rt = null;            // 走らせている処理系
let current = PROGRAMS[0].key;
let started = false, paused = false, stopped = false;
const LOG = [];                          // print() の出力（[send] 等の内部行は除く）
const NOISE = /^\\[(send|call|actor created|type|Loaded|Defined|Registered)/;

function engineReady() {
  if (AST) return Promise.resolve();
  return (async () => {
    AST = await import(urls.ast);
    ({ Interpreter } = await import(urls.interpreter));
    window.parser.yy = AST;
  })();
}

function progOf(key) { return PROGRAMS.find((p) => p.key === key) || PROGRAMS[0]; }

async function engineStart(key) {
  await engineReady();
  engineStop();                                   // 走っていれば止める
  current = key || current;
  LOG.length = 0;
  interp = new Interpreter((s) => { const t = String(s); if (!NOISE.test(t)) LOG.push(t); });
  rt = interp.runtime;
  // ---- 一時停止 / 再開 / 終了 を差し込む -------------------------------
  const sched = rt.scheduleActor.bind(rt);
  const proc = rt._processNextFor.bind(rt);
  rt.scheduleActor = (actor, delay) => { if (paused || stopped) { actor.__wake = true; return; } sched(actor, delay); };
  rt._processNextFor = (actor) => {
    if (stopped) { actor.mailbox.length = 0; return; }
    if (paused) { actor.scheduled = false; actor.__wake = true; return; }
    proc(actor);
  };
  paused = false; stopped = false; started = true;
  try {
    interp.runProgram(window.parser.parse(progOf(current).source));
  } catch (e) {
    LOG.push("[error] " + (e && e.message ? e.message : String(e)));
    started = false;
  }
}
function engineResume() {
  if (!rt || stopped) return;
  paused = false;
  for (const [, a] of rt.actors) if (!a.__dead && a.mailbox.length) { a.__wake = false; rt.scheduleActor(a, 0); }
}
function enginePause() { paused = true; }
function engineStop() {
  if (!rt) { started = false; return; }
  stopped = true;
  for (const [, a] of rt.actors) { a.__dead = true; a.mailbox.length = 0; }
}
function engineActors() {
  const out = [];
  if (rt) for (const [name, a] of rt.actors) {
    const fields = {};
    for (const [k, v] of Object.entries(a.state || {})) fields[k] = v;
    out.push({
      name, class: a.className,
      state: a.__dead ? "stopped" : (a.processing ? "busy" : "idle"),
      mailbox: a.mailbox.length,
      thread: a.__dead ? null : "event loop",
      alive: !a.__dead,
      fields,
    });
  }
  return { actors: out, paused, stopped, started };
}

// ---- ここから下は Py-I 版と同じ役目の関数（fetch の代わりに上を呼ぶ）----
function loadProg() {
  const p = progOf(current);
  document.getElementById('path').textContent = p.path || p.key;
  const cls = (p.source.match(/class\\s+(\\w+)/g) || []).map((m) => m.split(/\\s+/)[1]);
  document.getElementById('classes').textContent = cls.join(', ') || '(none)';
  document.getElementById('src').textContent = p.source;
}
async function ctl(action) {
  if (action === 'start') {
    const sel = document.getElementById('progsel');
    if (sel && sel.value) current = sel.value;
    conSince = 0; document.getElementById('console').textContent = '';
    await engineStart(current);
    loadProg();
  } else if (action === 'pause') enginePause();
  else if (action === 'resume') engineResume();
  else if (action === 'stop') engineStop();
  const s = engineActors();
  setState(s.paused, s.stopped, s.started);
  tick();
}
function pushSpeed() {
  // Py-I 版は /api/speed でプロデューサ/コンシューマの間隔を変える。
  // こちらは走っているアクターのフィールド（delay 秒）を直接書き換える。
  const pe = document.getElementById('pspeed'), ce = document.getElementById('cspeed');
  if (!pe || !ce) return;
  const p = +pe.value, c = +ce.value;
  document.getElementById('pspeedv').textContent = p + ' ms';
  document.getElementById('cspeedv').textContent = c + ' ms';
  if (!rt) return;
  for (const [, a] of rt.actors) {
    if (a.className === 'Producer' && a.state && 'delay' in a.state) a.state.delay = p / 1000;
    if (a.className === 'Consumer' && a.state && 'delay' in a.state) a.state.delay = c / 1000;
  }
}
function tick() {
  const a = engineActors();
  document.getElementById('count').textContent = a.actors.length;
  document.getElementById('ts').textContent = new Date().toLocaleTimeString();
  setState(a.paused, a.stopped, a.started);
  drawViz(a.actors);
  const isBuf = a.actors.some((x) => x['class'] === 'Buffer' || x['class'] === 'Producer' || x['class'] === 'Consumer');
  const sc = document.getElementById('speedctl'); if (sc) sc.style.display = isBuf ? 'block' : 'none';
  const rows = a.actors.map((x) => {
    const f = Object.entries(x.fields || {}).map(([k, v]) => k + '=' + esc(JSON.stringify(v))).join('   ');
    const th = (x.alive !== false && x.thread != null) ? x.thread : '(dead)';
    return '<tr><td>' + esc(x.name) + '</td><td class="cls">' + esc(x['class']) + '</td>'
      + '<td class="' + x.state + '">' + x.state + '</td><td>' + x.mailbox + '</td>'
      + '<td>' + esc(th) + '</td>'
      + '<td class="fields">' + f + '</td></tr>';
  }).join('');
  document.getElementById('abody').innerHTML = rows || '<tr><td colspan="5">(no actors)</td></tr>';
}
let conSince = 0;
function conTick() {
  if (LOG.length <= conSince) return;
  const lines = LOG.slice(conSince); conSince = LOG.length;
  const el = document.getElementById('console');
  if (el.textContent === '(waiting for output...)') el.textContent = '';
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.textContent += lines.join('\\n') + '\\n';
  if (el.textContent.length > 40000) el.textContent = el.textContent.slice(-40000);
  if (atBottom) el.scrollTop = el.scrollHeight;
}
function loadPrograms() {
  const sel = document.getElementById('progsel');
  if (document.activeElement === sel) return;
  sel.innerHTML = PROGRAMS.map((x) =>
    '<option value="' + esc(x.key) + '"' + (x.key === current ? ' selected' : '') + '>' + esc(x.label) + '</option>').join('');
}
async function switchProgram() {
  const sel = document.getElementById('progsel');
  const key = sel.value; if (!key) return;
  const b = document.getElementById('b_switch'); b.disabled = true; b.textContent = 'Loading...';
  current = key; engineStop(); started = false; rt = null; interp = null;
  conSince = 0; document.getElementById('console').textContent = '(waiting for output...)';
  loadProg(); tick();
  b.disabled = false; b.textContent = 'Switch / Load';
}

loadPrograms(); loadProg(); tick();
setInterval(tick, 500); setInterval(conTick, 300); setInterval(loadPrograms, 5000);

// ===================== 日本語 / English =====================
// 元の Py-I 版は英語なので、こちらは日本語を data のかわりに表で持つ。
// 言語は ?lang=ja|en → localStorage('aipl.lang') → ブラウザ既定 の順で決める。
const JA = {
  t_h1: 'JS-I &mdash; AIPL 処理系（このページの中で動いています）',
  t_sub: 'Py-I 版ダッシュボード（<code>--dashboard PORT</code> → <code>/actors</code>）と同じ画面を、'
       + '<b>ブラウザの中の AIPL 処理系（JS-I）</b>で動かしています。サーバーもネットワークも使いません。',
  t_proglabel: 'プログラム:',
  t_viz: '可視化',
  t_actors: '動いているアクター',
  t_console: 'コンソール — print() の出力',
  t_program: 'いま動かしているプログラム',
  b_start: '▶ 開始', b_pause: '⏸ 一時停止', b_resume: '↻ 再開', b_stop: '■ 終了',
  b_switch: '切り替え / 読み込み',
};
const EN0 = {};
const LANGKEY = 'aipl.lang';
let LANG = new URLSearchParams(location.search).get('lang')
        || localStorage.getItem(LANGKEY)
        || ((navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en');
if (LANG !== 'ja' && LANG !== 'en') LANG = 'en';
const RUNSTATE_JA = { 'not started': '未起動', running: '実行中', paused: '一時停止', ended: '終了' };
const CAP_JA = ['名前', 'クラス', '状態', 'メールボックス', 'スレッド', 'フィールド（状態）'];
const CAP_EN = ['name', 'class', 'state', 'mailbox', 'thread', 'fields (state)'];
const VIZNOTE_JA = 'リング上の哲学者（青=考え中、琥珀=空腹/待ち・フォーク確保、灰=終了）。'
  + '間にフォークを描き、いま持っている哲学者へ緑の矢印が伸びます。<br>'
  + '※ JS-I の <code>sleep()</code> はメソッドの途中で止まれない（ブラウザは同期ブロックできない）ので、'
  + '「食事中」はメッセージの切れ目に現れません。Py-I 版では緑で見えます。';
const VIZNOTE_EN = 'Philosophers around the ring (blue = thinking, amber = hungry/waiting or holding a fork, '
  + 'grey = done). Forks are drawn between them, with a green arrow pointing at the holder.<br>'
  + 'Note: JS-I\\'s <code>sleep()</code> cannot block in the middle of a method (a browser cannot block '
  + 'synchronously), so the \\'eating\\' state never falls between two messages here; the Py-I version shows it in green.';
function applyLang() {
  document.documentElement.lang = LANG;
  for (const [id, ja] of Object.entries(JA)) {
    const el = document.getElementById(id); if (!el) continue;
    if (EN0[id] === undefined) EN0[id] = el.innerHTML;
    el.innerHTML = LANG === 'ja' ? ja : EN0[id];
  }
  const th = document.querySelectorAll('table thead th');
  th.forEach((e, i) => { e.textContent = (LANG === 'ja' ? CAP_JA : CAP_EN)[i] || e.textContent; });
  const note = document.querySelector('canvas#viz + div');
  if (note) note.innerHTML = LANG === 'ja' ? VIZNOTE_JA : VIZNOTE_EN;
  document.title = LANG === 'ja' ? 'JS-I — AIPL アクター（サーバー不要）' : 'JS-I — AIPL actors (standalone)';
  const b = document.getElementById('langBtn'); if (b) b.textContent = LANG === 'ja' ? 'EN' : '日本語';
  const rs = document.getElementById('runstate');
  if (rs && LANG === 'ja' && RUNSTATE_JA[rs.textContent]) rs.textContent = RUNSTATE_JA[rs.textContent];
}
// 実行状態の表示も言語に合わせる（元の setState を包む）
const setStateEn = setState;
setState = function (paused_, stopped_, started_) {
  setStateEn(paused_, stopped_, started_);
  const el = document.getElementById('runstate');
  if (LANG === 'ja' && RUNSTATE_JA[el.textContent]) el.textContent = RUNSTATE_JA[el.textContent];
};
document.getElementById('langBtn').onclick = () => {
  LANG = LANG === 'ja' ? 'en' : 'ja';
  localStorage.setItem(LANGKEY, LANG);
  applyLang(); tick();
};
applyLang();
`;

const script = "<script>\n" + PARSER.split("</script").join("<\\/script") + "\n</script>\n"
  + "<script>\n" + (js + engine).split("</script").join("<\\/script") + "\n</script>";
html = html.slice(0, apiStart) + script + html.slice(apiEnd + "</script>".length);

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${(html.length / 1e6).toFixed(2)} MB, programs: ${PROGRAMS.map((p) => basename(p.key)).join(", ")})`);
