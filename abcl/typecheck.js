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
