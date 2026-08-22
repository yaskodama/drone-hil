// typecheck.js — public façade for the HM-based AIPL type checker.
//
// The heavy lifting moved to:
//   - types.js  (type ADT + unify + scheme + registries)
//   - infer.js  (walker + dispatch + effect collection)
//
// This file preserves the historical export surface so that
// `interpreter.js` and `node-aipl-server/server.mjs` continue to work
// without changes:
//
//   import { runTypeCheck, TypeError, BUILTIN_EFFECTS, refined } from "./typecheck.js";

export { TypeError } from "./types.js";
export { BUILTIN_EFFECTS, runInference } from "./infer.js";
import { collectMethodEffects } from "./infer.js";

import { runInference as _runInference } from "./infer.js";

// ─── backward-compatible refined() helper ─────────────────────
// Pre-HM code used `refined(base, pred)` to wrap a type in a refinement
// predicate.  Now that refinement lives inside types.js::TRefined, this
// helper just returns the legacy shape — no caller in the current
// codebase reads the result (it was meant for the host-side z3 hook).
export function refined(base, pred) {
  return { kind: "refined", base, pred };
}

// ─── public entry point ───────────────────────────────────────
// `opts` is currently ignored — kept for API compatibility.
export function runTypeCheck(ast, _opts = {}) {
  return _runInference(ast);
}

// ---------------------------------------------------------------------------
// reply の線形性と、期限なしの待ち。
// OCaml 版 infer.ml の max_replies / replies_on_all_paths / check_deadline、
// および Py-I の aipl_typeck.py に対応する。
//
// これらは例外を投げない ---- 既存のデモを止めないため、診断として返し、
// 呼び出し側が表示する。期限は AIPL_STRICT_DEADLINE で厳格にできる。

function stmtsOf(node) {
  if (!node) return [];
  if (node.type === "Seq") return node.statements || [];
  if (Array.isArray(node)) return node;
  return [node];
}

function maxReplies(stmts) {
  let total = 0;
  for (const st of stmts) {
    total += maxRepliesStmt(st);
    if (total >= 2) return 2;
  }
  return total;
}

function maxRepliesStmt(st) {
  if (!st) return 0;
  switch (st.type) {
    case "Reply": return 1;
    case "If":
      return Math.max(maxReplies(stmtsOf(st.thenBody)),
                      maxReplies(stmtsOf(st.elseBody)));
    case "While":
      // 本体が返すなら、ループで複数回返りうる
      return maxReplies(stmtsOf(st.body)) > 0 ? 2 : 0;
    case "Seq": return maxReplies(st.statements || []);
    case "Select":
      // case 本体の reply は「選ばれたメッセージ」への返信であって
      // このメソッド自身の返信ではない。数えない（OCaml 版と同じ）。
      // timeout 本体は自分の返信なので数える。
      return st.timeoutBody ? maxReplies(stmtsOf(st.timeoutBody)) : 0;
    default: return 0;
  }
}

function repliesOnAllPaths(stmts) {
  for (const st of stmts) if (repliesHere(st)) return true;
  return false;
}

function repliesHere(st) {
  if (!st) return false;
  if (st.type === "Reply") return true;
  if (st.type === "If") {
    if (!st.elseBody) return false;   // else が無ければ抜ける経路がある
    return repliesOnAllPaths(stmtsOf(st.thenBody))
        && repliesOnAllPaths(stmtsOf(st.elseBody));
  }
  if (st.type === "Seq") return repliesOnAllPaths(st.statements || []);
  return false;
}

// 期限を書いていない now / await を拾う
function scanUnboundedWaits(node, found) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) scanUnboundedWaits(x, found); return; }
  if (node.type === "Now"   && !node.deadline) found.push("now");
  if (node.type === "Await" && !node.deadline) found.push("await");
  for (const k of Object.keys(node)) {
    if (k === "type" || k === "deadline") continue;
    scanUnboundedWaits(node[k], found);
  }
}

export function checkReplyAndDeadlines(ast, opts = {}) {
  const out = [];
  const strict = !!opts.strictDeadline;
  for (const cls of (ast.classes || [])) {
    for (const m of (cls.methods || [])) {
      const where = `method ${cls.name}.${m.name}`;
      const stmts = stmtsOf(m.body);

      const n = maxReplies(stmts);
      if (n >= 2) {
        out.push({ where, severity: "error",
                   message: "reply が複数回起こりうる（返信は高々一度）" });
      }
      const ret = m.ret;
      if (ret && ret !== "unit") {
        if (n === 0) {
          out.push({ where, severity: "error",
                     message: `戻り値型 ${ret} を宣言しているが reply が無い` });
        } else if (!repliesOnAllPaths(stmts)) {
          out.push({ where, severity: "error",
                     message: `戻り値型 ${ret} を宣言しているが reply しない経路がある` });
        }
      }

      const waits = [];
      scanUnboundedWaits(m.body, waits);
      for (const kind of waits) {
        out.push({ where, severity: strict ? "error" : "warning",
                   message: `${kind} に期限が無い（\`${kind} ... timeout <ms> else <expr>\` と書く）` });
      }
    }
  }
  // トップレベルの文にも期限なしの待ちは現れる（クラスの外で
  // `print(now front.place(3));` と書ける）。ここを見落とすと
  // OCaml 版が3件警告するファイルで1件しか出ず、検査が過小報告になる。
  const topWaits = [];
  scanUnboundedWaits(ast.statements || ast.stmts || [], topWaits);
  for (const kind of topWaits) {
    out.push({ where: "top level", severity: strict ? "error" : "warning",
               message: `${kind} に期限が無い（\`${kind} ... timeout <ms> else <expr>\` と書く）` });
  }
  return out;
}

// ---------------------------------------------------------------------
// 宣言した効果と、本体から集めた効果の照合。
// infer.js の collectMethodEffects は呼び出しの辺と不動点まで持っているのに、
// その結果を宣言（md.eff）と突き合わせる箇所がどこにも無かった。
// そのため `!{log}` と書いたメソッドが mut / ai / net を持っていても素通りしていた。
// OCaml 版 infer.ml の check_effect_annotations、Py-I の
// _check_effect_declarations に対応する。
// ---------------------------------------------------------------------
export function checkEffectDeclarations(ast) {
  const issues = [];
  // 例外は握りつぶさない。握りつぶすと「検査したのに何も出ない」状態になり、
  // 実際これで一度、未定義の関数を呼んでいることに気づけなかった。
  const effects = collectMethodEffects(ast);
  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) {
      const declared = md.eff;   // 未注釈なら undefined。その場合は推論に任せる
      if (!declared) continue;
      const dset = new Set(declared);
      const actual = (effects[cls.name] && effects[cls.name][md.name]) || new Set();
      const missing = [...actual].filter(e => !dset.has(e)).sort();
      if (missing.length) {
        issues.push(
          `method ${cls.name}.${md.name}: effect set incomplete — declared {` +
          [...dset].sort().join(", ") + `} but uses {` +
          [...actual].sort().join(", ") + `}; missing: {` + missing.join(", ") + `}`);
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------
// 未宣言の名前への代入。
// 読み出しは弾かれるのに代入だけ素通りしていたので、
// フィールド名を打ち間違えると、フィールドは更新されないまま
// 別の変数ができて何のエラーも出なかった。
// AIOS_LAX_ASSIGN=1（Node なら env）で従来の暗黙宣言に戻せる。
// ---------------------------------------------------------------------
export function checkUndeclaredAssign(ast) {
  const issues = [];
  const lax = (typeof process !== "undefined" &&
               ["1", "true", "yes"].includes(process.env?.AIOS_LAX_ASSIGN));
  if (lax) return issues;

  for (const cls of (ast.classes || [])) {
    const fields = new Set((cls.fields || []).map(f => f.name));
    for (const md of (cls.methods || [])) {
      const known = new Set([...fields, ...(md.params || []),
                             "self", "sender"]);
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        switch (n.type) {
          case "VarDecl":
            walk(n.expr);
            known.add(n.name);          // 宣言はここから有効
            return;
          case "Assign":
            if (!known.has(n.name)) {
              issues.push(
                `method ${cls.name}.${md.name}: 未宣言の名前 \`${n.name}\` に代入している` +
                `（\`var ${n.name} = ...\` と宣言する）`);
            }
            walk(n.expr);
            return;
          default: {
            for (const k of Object.keys(n)) {
              const v = n[k];
              if (Array.isArray(v)) v.forEach(walk);
              else if (v && typeof v === "object") walk(v);
            }
          }
        }
      };
      walk(md.body);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------
// 期限が正でない now / await。0 ミリ秒は待ちにならないので、
// 書いた本人の意図と実際がずれる。
// OCaml 版は `timeout must be positive` として弾いている。
// ---------------------------------------------------------------------
export function checkBadDeadlines(ast) {
  const issues = [];
  const seen = new Set();
  const walk = (n, where) => {
    if (!n || typeof n !== "object") return;
    if ((n.type === "Now" || n.type === "Await") && n.deadline) {
      const ms = (typeof n.deadline.ms === "number") ? n.deadline.ms
               : (typeof n.deadline.ms?.value === "number") ? n.deadline.ms.value
               : null;
      if (ms !== null && ms <= 0) {
        const key = `${where}|${n.type}|${ms}`;
        if (!seen.has(key)) {
          seen.add(key);
          issues.push(`${where}: ${n.type === "Now" ? "now" : "await"} の期限が ${ms} ミリ秒（正の値でなければならない）`);
        }
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(x => walk(x, where));
      else if (v && typeof v === "object") walk(v, where);
    }
  };
  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) walk(md.body, `method ${cls.name}.${md.name}`);
  }
  // トップレベルにも現れる（`print(now c.f(1) timeout 0 else 0);`）
  for (const st of (ast.statements || ast.stmts || [])) walk(st, "top level");
  return issues;
}

// ---------------------------------------------------------------------
// 資源の使用順序（acquire / release）と、循環待ち（now / await の閉路）。
// OCaml 版 infer.ml の check_resource_use / wait_cycle、
// Py-I の _check_resource_use / _check_wait_cycle に対応する。
// ---------------------------------------------------------------------
function resNameOf(n) {
  const a = n.args || [];
  if (a.length === 1 && a[0] && a[0].type === "StringLit") return a[0].value;
  return null;
}

export function checkResourceUse(ast) {
  const issues = [];
  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) {
      const where = `method ${cls.name}.${md.name}`;
      const say = (m) => issues.push(`${where}: ${m}`);

      const expr = (e, held) => {
        if (!e || typeof e !== "object") return held;
        if (e.type === "CallExpr" || e.type === "CallStmt") {
          const r = resNameOf(e);
          if (e.name === "acquire" && r !== null) {
            if (held.has(r)) { say(`資源 ${r} を二重に acquire している`); return held; }
            const h = new Set(held); h.add(r); return h;
          }
          if (e.name === "release" && r !== null) {
            if (!held.has(r)) { say(`取得していない資源 ${r} を release している`); return held; }
            const h = new Set(held); h.delete(r); return h;
          }
        }
        for (const k of Object.keys(e)) {
          const v = e[k];
          if (Array.isArray(v)) for (const x of v) held = expr(x, held);
          else if (v && typeof v === "object") held = expr(v, held);
        }
        return held;
      };

      const same = (a, b) =>
        a.size === b.size && [...a].every(x => b.has(x));

      const stmt = (st, held) => {
        if (!st || typeof st !== "object") return held;
        switch (st.type) {
          case "Seq":
            for (const x of (st.statements || [])) held = stmt(x, held);
            return held;
          case "If": {
            const h = expr(st.cond, held);
            const ha = stmt(st.thenBody, h);
            const hb = st.elseBody ? stmt(st.elseBody, h) : h;
            if (!same(ha, hb)) {
              const d = [...new Set([...ha, ...hb])].filter(x => ha.has(x) !== hb.has(x));
              say(`二つの枝で持っている資源が食い違う（${d.join(", ")}）`);
            }
            return ha;
          }
          case "While": {
            const h = expr(st.cond, held);
            const hb = stmt(st.body, h);
            if (!same(h, hb)) say("ループの本体は持ち物を変えてはならない");
            return h;
          }
          default:
            return expr(st, held);
        }
      };

      const left = stmt(md.body, new Set());
      if (left.size) {
        say(`資源 ${[...left].sort().join(", ")} を持ったままメソッドを抜けている`);
      }
    }
  }
  return issues;
}

export function checkWaitCycle(ast) {
  // 宛先のクラスを解決して、待つ呼び出し（Now / Await 経由の Future）の辺を作る。
  const fieldClass = {}, edges = [];
  for (const cls of (ast.classes || [])) {
    fieldClass[cls.name] = {};
    for (const f of (cls.fields || [])) {
      if (f.expr && f.expr.type === "NewExpr") fieldClass[cls.name][f.name] = f.expr.className;
    }
  }
  const classOfParam = (md, name) => {
    const i = (md.params || []).indexOf(name);
    return (i >= 0 && md.paramTypes && md.paramTypes[i]) ? md.paramTypes[i] : null;
  };
  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) {
      const from = `${cls.name}.${md.name}`;
      const localClass = {};
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (n.type === "VarDecl" && n.expr && n.expr.type === "NewExpr") {
          localClass[n.name] = n.expr.className;
        }
        if (n.type === "Now" || n.type === "Future") {
          const t = (typeof n.target === "string") ? n.target
                  : (n.target && n.target.name) ? n.target.name : null;
          let c = null;
          if (n.target && n.target.type === "NewExpr") c = n.target.className;
          else if (t === "self") c = cls.name;
          else if (t) c = localClass[t] || fieldClass[cls.name][t] || classOfParam(md, t);
          if (c) edges.push([from, `${c}.${n.method}`]);
        }
        for (const k of Object.keys(n)) {
          const v = n[k];
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") walk(v);
        }
      };
      walk(md.body);
    }
  }
  const succ = {};
  for (const [a, b] of edges) (succ[a] = succ[a] || []).push(b);
  const state = {}, found = [];
  const dfs = (path, n) => {
    if (found.length) return;
    if (state[n] === 1) {
      const i = path.indexOf(n);
      found.push(i >= 0 ? path.slice(i).concat([n]) : [n]);
      return;
    }
    if (state[n] === 2) return;
    state[n] = 1;
    for (const m of (succ[n] || [])) dfs(path.concat([n]), m);
    state[n] = 2;
  };
  for (const k of Object.keys(succ)) if (!found.length) dfs([], k);
  if (!found.length) return [];
  return [`循環待ち: ${found[0].join(" -> ")}（now/await の閉路。期限が無ければ確実に詰まる）`];
}
