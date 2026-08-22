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

      // replyto を使うメソッドでは、返信の義務は線形性の検査が担う。
      // reply の回数・被覆の構文検査は適用しない（OCaml 版・Py-I と同じ）。
      if (usesReplyto(m.body)) continue;
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

// 本体のどこかで replyto を使っているか。
function usesReplyto(n) {
  if (!n || typeof n !== "object") return false;
  if (n.type === "Var" && n.name === "replyto") return true;
  for (const k of Object.keys(n)) {
    const v = n[k];
    if (Array.isArray(v)) { if (v.some(usesReplyto)) return true; }
    else if (v && typeof v === "object") { if (usesReplyto(v)) return true; }
  }
  return false;
}

// ---------------------------------------------------------------------
// 返信先の線形性。replyto で取り出した義務は、ちょうど一度 answer するか、
// 送信の引数に渡して相手へ移す。状態は (owed, spent) の対で持つ ----
// 消すだけだと二度渡しがただの変数参照に見えて素通りする。
// OCaml 版 infer.ml の check_reply_linearity と同じ規律。
// ---------------------------------------------------------------------
export function checkReplyLinearity(ast) {
  const issues = [];
  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) {
      const where = `method ${cls.name}.${md.name}`;
      const say = (m) => issues.push(`${where}: ${m}`);
      const eq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

      const expr = (e, st) => {
        if (!e || typeof e !== "object") return st;
        let [owed, spent] = st;
        if ((e.type === "CallExpr" || e.type === "CallStmt") && e.name === "answer") {
          const a0 = (e.args || [])[0];
          if (a0 && a0.type === "Var") {
            if (spent.has(a0.name)) { say(`返信先 ${a0.name} を二度使っている`); return st; }
            if (a0.name !== "replyto" && !owed.has(a0.name)) {
              say(`返信先 ${a0.name} は replyto から取り出されていない`); return st;
            }
            if (a0.name !== "replyto") {
              const o = new Set(owed), p = new Set(spent);
              o.delete(a0.name); p.add(a0.name);
              return [o, p];
            }
          }
          return st;
        }
        if (e.type === "Send" || e.type === "Now" || e.type === "Future") {
          for (const a of (e.args || [])) {
            if (a && a.type === "Var") {
              if (spent.has(a.name)) say(`返信先 ${a.name} を二度使っている`);
              else if (owed.has(a.name)) {
                const o = new Set(owed), p = new Set(spent);
                o.delete(a.name); p.add(a.name);
                owed = o; spent = p;
              }
            } else { [owed, spent] = expr(a, [owed, spent]); }
          }
          return [owed, spent];
        }
        for (const k of Object.keys(e)) {
          const v = e[k];
          if (Array.isArray(v)) for (const x of v) [owed, spent] = expr(x, [owed, spent]);
          else if (v && typeof v === "object") [owed, spent] = expr(v, [owed, spent]);
        }
        return [owed, spent];
      };

      const stmt = (n, st) => {
        if (!n || typeof n !== "object") return st;
        switch (n.type) {
          case "VarDecl":
            if (n.expr && n.expr.type === "Var" && n.expr.name === "replyto") {
              const o = new Set(st[0]); o.add(n.name);
              return [o, st[1]];
            }
            return expr(n.expr, st);
          case "Seq": {
            let cur = st;
            for (const x of (n.statements || [])) cur = stmt(x, cur);
            return cur;
          }
          case "If": {
            const s0 = expr(n.cond, st);
            const a = stmt(n.thenBody, s0);
            const b = n.elseBody ? stmt(n.elseBody, s0) : s0;
            if (!eq(a[0], b[0])) say("二つの枝で果たしていない返信先が食い違う");
            return a;
          }
          case "While": {
            const s0 = expr(n.cond, st);
            const sb = stmt(n.body, s0);
            if (!eq(sb[0], s0[0])) say("ループの本体は返信の義務を変えてはならない");
            return s0;
          }
          default:
            return expr(n, st);
        }
      };

      const start = new Set();
      (md.params || []).forEach((p, i) => {
        if (md.paramTypes && md.paramTypes[i] === "reply") start.add(p);
      });
      const [owed] = stmt(md.body, [start, new Set()]);
      if (owed.size) {
        say(`返信先 ${[...owed].sort().join(", ")} に答えないままメソッドを抜けている`);
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------
// (1) reply の全域性 ---- now/await で待たれるメソッドは必ず返す。
//     デッドロックは循環待ちだけではない。閉路が無くても、
//     呼ばれる側が reply しなければ待ちは返らない。
// (2) 義務レベル ---- now/await は厳密に大きいレベルへしか向かえない。
//     両端に注釈があるときだけ検査する（明示宣言のみの段階）。
// 待ちの辺は checkWaitCycle と同じ作り方で集める。
// ---------------------------------------------------------------------
function waitEdgesOf(ast) {
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
  return edges;
}

export function checkReplyTotality(ast) {
  const issues = [];
  const waited = new Set(waitEdgesOf(ast).map(([, b]) => b));
  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) {
      const key = `${cls.name}.${md.name}`;
      if (!waited.has(key)) continue;
      if (usesReplyto(md.body)) continue;
      if (!repliesOnAllPaths(stmtsOf(md.body))) {
        issues.push(`method ${cls.name}.${md.name}: now/await で待たれるのに、reply しない経路がある`);
      }
    }
  }
  return issues;
}

// 注釈が無いメソッドにはレベルを推論する ---- 待ちの辺 (a,b) を見て
// level(b) <= level(a) なら b を押し上げる、を不動点まで繰り返す。
// 明示注釈は固定点で、押し上げが要るのに動かせなければそこが矛盾。
// これで片方にしか注釈が無い辺も検査できる。
// node_level("n", k) を読む。宛先の実体は別ノードにあり静的に見えないので、
// ノード単位の階層で近似する。
function nodeFloorsOf(ast) {
  const floors = {};
  for (const st of (ast.statements || ast.stmts || [])) {
    if (st && st.type === "CallStmt" && st.name === "node_level") {
      const a = st.args || [];
      if (a.length === 2 && a[0].type === "StringLit" && a[1].type === "IntLit") {
        floors[a[0].value] = a[1].value;
      }
    }
  }
  return floors;
}

// 遠隔への待ち。remote("node","actor") は宛先名が "node/actor" になる。
function remoteWaitsOf(ast) {
  const out = [];
  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) {
      const from = `${cls.name}.${md.name}`;
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if ((n.type === "Now" || n.type === "Future") && typeof n.target === "string"
            && n.target.includes("/")) {
          out.push([from, n.target.split("/")[0]]);
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
  return out;
}

export function checkLevels(ast) {
  const issues = [], lv = {}, fixed = new Set();
  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) {
      const key = `${cls.name}.${md.name}`;
      const n = md.level;
      lv[key] = (n === null || n === undefined) ? 0 : n;
      if (n !== null && n !== undefined) fixed.add(key);
    }
  }
  const edges = waitEdgesOf(ast);
  let converged = false;
  for (let i = 0; i < 1000; i++) {
    let changed = false;
    for (const [a, b] of edges) {
      const la = lv[a] || 0, lb = lv[b] || 0;
      if (lb <= la) {
        if (fixed.has(b)) {
          issues.push(`義務レベル: ${a} (@${la}) が ${b} (@${lb}) を待っている` +
                      `（待ちは厳密に大きいレベルへ向かわなければならない）`);
          return issues;
        }
        lv[b] = la + 1;
        changed = true;
      }
    }
    if (!changed) { converged = true; break; }
  }
  if (!converged) {
    issues.push("義務レベルが収束しない（待ちのグラフに閉路がある）");
    return issues;
  }
  const floors = nodeFloorsOf(ast);
  for (const [caller, node] of remoteWaitsOf(ast)) {
    if (node in floors && floors[node] <= (lv[caller] || 0)) {
      issues.push(`義務レベル: ${caller} (@${lv[caller] || 0}) が ノード ${node}` +
                  `（下限 @${floors[node]}）を待っている` +
                  `（ノードをまたぐ待ちは上へ向かわなければならない）`);
    }
  }
  if (typeof process !== "undefined" && process.env?.AIOS_SHOW_LEVELS === "1") {
    for (const [k, v] of Object.entries(lv).sort((x, y) => x[1] - y[1])) {
      console.error(`[level] ${k.padEnd(28)} @${v}${fixed.has(k) ? " (declared)" : ""}`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------
// select の規律。待ちが返らなくなる三つ目の経路 ----
// 閉路でも返信漏れでもなく、「誰も送らない」だけで詰まる。
//   1. 期限を書く（書かなければ警告。now / await と同じ）
//   2. 待つメッセージを誰かが送っているか
// 外部からの送り手（web_expose / web_listen / deploy / remote）があれば
// 当てにならないので検査しない。
// ---------------------------------------------------------------------
export function checkSelect(ast) {
  const issues = [];
  const strictDl = typeof process !== "undefined" &&
                   ["1", "true", "yes"].includes(process.env?.AIOS_STRICT_DEADLINE);
  const strictSel = typeof process !== "undefined" &&
                    ["1", "true", "yes"].includes(process.env?.AIOS_STRICT_SELECT);

  // 送られたメッセージを集める
  const sent = new Set();
  const fieldClass = {};
  for (const cls of (ast.classes || [])) {
    fieldClass[cls.name] = {};
    for (const f of (cls.fields || [])) {
      if (f.expr && f.expr.type === "NewExpr") fieldClass[cls.name][f.name] = f.expr.className;
    }
  }
  let external = false;
  const collectSent = (n, ownerCls, md, localClass) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "VarDecl" && n.expr && n.expr.type === "NewExpr") {
      localClass[n.name] = n.expr.className;
    }
    if (n.type === "Send" || n.type === "Now" || n.type === "Future") {
      const t = (typeof n.target === "string") ? n.target
              : (n.target && n.target.name) ? n.target.name : null;
      if (t && t.includes("/")) external = true;
      let c = null;
      if (n.target && n.target.type === "NewExpr") c = n.target.className;
      else if (t === "self") c = ownerCls;
      else if (t) {
        const i = md ? (md.params || []).indexOf(t) : -1;
        c = localClass[t] || (fieldClass[ownerCls] || {})[t]
            || (i >= 0 && md.paramTypes ? md.paramTypes[i] : null);
      }
      if (c) sent.add(`${c}.${n.method}`);
    }
    if ((n.type === "CallStmt" || n.type === "CallExpr") &&
        ["web_expose", "web_listen", "deploy"].includes(n.name)) external = true;
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(x => collectSent(x, ownerCls, md, localClass));
      else if (v && typeof v === "object") collectSent(v, ownerCls, md, localClass);
    }
  };
  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) collectSent(md.body, cls.name, md, {});
  }
  // トップレベルの `var x = new C();` を先に拾っておかないと、
  // `send w.serve();` の宛先クラスが分からず「誰も送っていない」と誤検出する。
  const topLocal = {};
  for (const st of (ast.statements || ast.stmts || [])) {
    if (st && st.type === "VarDecl" && st.expr && st.expr.type === "NewExpr") {
      topLocal[st.name] = st.expr.className;
    }
  }
  for (const st of (ast.statements || ast.stmts || [])) collectSent(st, null, null, topLocal);

  // select を見る
  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) {
      const where = `method ${cls.name}.${md.name}`;
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (n.type === "Select") {
          if (n.timeoutMs === null || n.timeoutMs === undefined) {
            const msg = `${where}: 期限の無い select は永久に待ちうる（\`timeout <ms> -> { ... }\` と書く）`;
            issues.push(msg);
          }
          if (!external) {
            for (const c of (n.cases || [])) {
              const mn = c.method || c.name;
              if (mn && !sent.has(`${cls.name}.${mn}`)) {
                issues.push(`${where}: select が ${cls.name}.${mn} を待っているが、` +
                            `このプログラムの中で誰も送っていない`);
              }
            }
          }
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
  void strictDl; void strictSel;
  return issues;
}

// ---------------------------------------------------------------------
// セッション型 ---- 実行時のプロトコルを型検査へ持ち上げる。
// protocol_define / protocol_start / protocol_end を読み、
// トップレベルの送信の順序が約束どおりかを走らせる前に見る。
// セッションがアクターをまたぐ場合は静的に追えないので、
// 「やり残し」は既定では言わない（AIOS_STRICT_PROTOCOL=1 で警告）。
// ---------------------------------------------------------------------
function parseProtoSpec(spec) {
  const out = [];
  for (const part of String(spec).split("->")) {
    const p = part.trim();
    const i = p.indexOf(".");
    if (i > 0) out.push([p.slice(0, i).trim(), p.slice(i + 1).trim()]);
  }
  return out;
}

function sendsOfNode(n, acc) {
  if (!n || typeof n !== "object") return;
  if (n.type === "Send" || n.type === "Now" || n.type === "Future") {
    for (const a of (n.args || [])) sendsOfNode(a, acc);
    const t = (typeof n.target === "string") ? n.target
            : (n.target && n.target.name) ? n.target.name : null;
    if (t && n.method) acc.push([t, n.method]);
    return;
  }
  if ((n.type === "CallExpr" || n.type === "CallStmt") &&
      ["aios_now", "aios_send", "remote_now"].includes(n.name)) {
    const a = n.args || [];
    if (a.length >= 2 && a[0].type === "StringLit" && a[1].type === "StringLit") {
      for (const x of a.slice(2)) sendsOfNode(x, acc);
      acc.push([a[0].value, a[1].value]);
      return;
    }
  }
  for (const k of Object.keys(n)) {
    const v = n[k];
    if (Array.isArray(v)) v.forEach(x => sendsOfNode(x, acc));
    else if (v && typeof v === "object") sendsOfNode(v, acc);
  }
}

export function checkProtocols(ast) {
  const issues = [];
  const stmts = ast.statements || ast.stmts || [];
  const defs = {};
  for (const st of stmts) {
    if (st && st.type === "CallStmt" && st.name === "protocol_define") {
      const a = st.args || [];
      if (a.length === 2 && a[0].type === "StringLit" && a[1].type === "StringLit") {
        defs[a[0].value] = parseProtoSpec(a[1].value);
      }
    }
  }
  if (!Object.keys(defs).length) return issues;

  const top = [];
  for (const st of stmts) sendsOfNode(st, top);
  const inTop = (s) => top.some(([a, m]) => a === s[0] && m === s[1]);

  const strict = typeof process !== "undefined" &&
                 process.env?.AIOS_STRICT_PROTOCOL === "1";
  let active = null, cur = [], full = false;
  for (const st of stmts) {
    let started = null;
    if (st.type === "CallStmt" && st.name === "protocol_start") {
      const a = st.args || [];
      if (a[0] && a[0].type === "StringLit") started = a[0].value;
    } else if (st.type === "VarDecl" && st.expr &&
               st.expr.type === "CallExpr" && st.expr.name === "protocol_start") {
      const a = st.expr.args || [];
      if (a[0] && a[0].type === "StringLit") started = a[0].value;
    }
    if (started !== null) {
      if (!(started in defs)) issues.push(`protocol_start: 未知のプロトコル ${started}`);
      else { active = started; cur = defs[started].slice(); full = defs[started].every(inTop); }
      continue;
    }
    if (st.type === "CallStmt" && st.name === "protocol_end") {
      if (active !== null && cur.length) {
        const [a, m] = cur[0];
        const msg = `プロトコル ${active} が protocol_end の時点で未完了（次に期待するのは ${a}.${m}）`;
        if (full) issues.push(msg);
        else if (strict) issues.push(msg + "（続きは別のアクターの中かもしれない）");
      }
      active = null; cur = [];
      continue;
    }
    if (active === null) continue;
    const acc = [];
    sendsOfNode(st, acc);
    const all = defs[active];
    for (const [t, m] of acc) {
      if (!all.some(([a, b]) => a === t && b === m)) continue;   // 無関係な送信
      if (!cur.length) continue;
      const [ea, em] = cur[0];
      if (ea === t && em === m) cur = cur.slice(1);
      else {
        issues.push(`プロトコル ${active}: ${ea}.${em} を期待しているが ${t}.${m} を送っている`);
        return issues;
      }
    }
  }
  if (active !== null && cur.length) {
    const [a, m] = cur[0];
    const msg = `プロトコル ${active} が完了していない（次に期待するのは ${a}.${m}）`;
    if (full) issues.push(msg);
    else if (strict) issues.push(msg);
  }
  return issues;
}
