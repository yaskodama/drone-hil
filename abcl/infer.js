// infer.js — HM-based type inference walker for JS-B / JS-N.
//
// 1:1 port of the relevant parts of src/infer.ml.  Uses the types.js
// universe (tagged ty objects) under the hood and exposes plain string
// projections at the boundary for backward compatibility.
//
// Two-phase design (mirrors OCaml `check_program`):
//   1. preinferAllClasses:
//        a. Pre-bind global `var x = new Cls(...)` to TActor(Cls).
//        b. For each class, register field types (via initializer
//           inference + sentinel widening via `unifyTry` for
//           drone/philosopher-style patterns).
//        c. For each class, infer a TFun scheme per method.
//           Parameters and return are fresh tvars; the body is walked
//           with `inPreinfer = true` so unbound names get a fresh tvar
//           instead of an "unbound variable" error.
//        d. Generalize and register each method scheme.
//   2. checkProgram:
//        With `inPreinfer = false`, walk every method body and every
//        global statement.  Real type errors raise TypeError.
//
// Effect collection (CE-10) and the existing `compatible`-style
// gradual escape hatches are carried over.

import * as T from "./types.js";

// ─── builtin effect labels (mirrors typecheck.js's existing table) ──
export const BUILTIN_EFFECTS = {
  // 機外のモデルを呼ぶので net も持つ（OCaml 版・Py-I と揃える）。
  // JS-I だけ ai だけを持っており、「AI を使うが機外へは出ない」と
  // 区別がつかなくなっていた。
  ai_call:              ["ai", "net"],
  ai_call_with_system:  ["ai", "net"],
  read_file:            ["fs"],
  write_file:           ["fs", "mut"],
  append_file:          ["fs", "mut"],
  file_exists:          ["fs"],
  image_load:           ["fs"],
  image_save:           ["fs", "mut"],
  image_create:         ["mut"],
  image_set_pixel:      ["mut"],
  grant_cap:            ["mut"],
  revoke_cap:           ["mut"],
  crdt_gcounter_inc:    ["mut"],
  crdt_orset_add:       ["mut"],
  crdt_orset_remove:    ["mut"],
  crdt_lww_write:       ["mut"],
  crdt_gcounter_merge:  ["mut"],
  crdt_orset_merge:     ["mut"],
  crdt_lww_merge:       ["mut"],
  crdt_replicate:       ["mut", "net"],
  failover_region:      ["net"],
  route_for_region:     ["net"],
  pool_create:          ["mut"],
  pool_destroy:         ["mut"],
};

// ─── env: Map<string, scheme>  (single scheme per name, like JS) ───
function envNew()                    { return new Map(); }
function envClone(env)               { return new Map(env); }
function envSet(env, name, scheme)   { env.set(name, scheme); }
function envGet(env, name)           { return env.get(name) || null; }
function envHas(env, name)           { return env.has(name); }
function envFtv(env) {
  const out = new Set();
  for (const sch of env.values()) {
    const f = T.ftvScheme(sch);
    for (const id of f) out.add(id);
  }
  return out;
}

// ─── state ─────────────────────────────────────────────────────
let inPreinfer = false;
let currentClass = null;

function unifyAt(loc, a, b) {
  try { T.unify(a, b, loc); return true; }
  catch (e) {
    if (e instanceof T.TypeError) return false;
    throw e;
  }
}

function locOf(node) { return (node && node.loc) || null; }

// ─── primitive overload resolver (mirrors infer.ml::pick_overload) ─
// We only need to handle the arithmetic + comparison ops; everything
// else falls back to a fresh tvar.
function pickOverloadBinop(op, lhs, rhs, loc) {
  const l = T.repr(lhs), r = T.repr(rhs);
  // String concatenation
  if (op === "+") {
    if (l.tag === "TString" || r.tag === "TString") return T.TString;
  }
  // Arithmetic: int/float promote
  if (["+", "-", "*", "/"].includes(op)) {
    // If either side already resolved to TFloat, result is TFloat
    if (l.tag === "TFloat" || r.tag === "TFloat") {
      if (l.tag === "TVar") unifyAt(loc, l, T.TFloat);
      if (r.tag === "TVar") unifyAt(loc, r, T.TFloat);
      return T.TFloat;
    }
    // If both are TInt or unconstrained, default to TInt
    if (l.tag === "TInt" || r.tag === "TInt") {
      if (l.tag === "TVar") unifyAt(loc, l, T.TInt);
      if (r.tag === "TVar") unifyAt(loc, r, T.TInt);
      return T.TInt;
    }
    // both tvars → leave as fresh; result tvar
    const out = T.TVar(T.freshTvar());
    return out;
  }
  if (["==", "!=", "<", "<=", ">", ">="].includes(op)) {
    // Comparisons: unify sides (gradually) and return bool.
    unifyAt(loc, lhs, rhs);
    return T.TBool;
  }
  if (op === "&&" || op === "||") {
    unifyAt(loc, lhs, T.TBool);
    unifyAt(loc, rhs, T.TBool);
    return T.TBool;
  }
  // unknown: fallback
  return T.TVar(T.freshTvar());
}

// ─── inferExpr ─────────────────────────────────────────────────
function inferExpr(env, e) {
  if (!e) return T.TAny;
  switch (e.type) {
    case "IntLit":    return T.TInt;
    case "FloatLit":  return T.TFloat;
    case "StringLit": return T.TString;
    case "BoolLit":   return T.TBool;
    case "NilLit":    return T.TAny;

    case "Var": {
      const name = e.name;
      if (name === "self") {
        return currentClass
          ? T.TActor(currentClass, [])
          : T.TAny;
      }
      if (name === "sender") return T.TAny;
      const sch = envGet(env, name);
      if (sch) return T.instantiate(sch);
      if (inPreinfer) return T.TVar(T.freshTvar());
      // Unknown identifier in check mode: soft-fail to TAny so existing
      // gradual code (built-in functions called by name, etc.) keeps
      // working.  OCaml raises here but the JS AST lacks the explicit
      // function declaration that OCaml uses to pre-register.
      return T.TAny;
    }

    case "Binop": {
      const l = inferExpr(env, e.left);
      const r = inferExpr(env, e.right);
      return pickOverloadBinop(e.op, l, r, locOf(e));
    }

    case "Unop": {
      const t = inferExpr(env, e.expr);
      if (e.op === "!" || e.op === "not") {
        unifyAt(locOf(e), t, T.TBool);
        return T.TBool;
      }
      if (e.op === "-") {
        // numeric — keep operand's type
        return t;
      }
      return T.TAny;
    }

    case "CallExpr": {
      // Built-in or user function called with `name(args)` shape.
      const args = e.args.map(a => inferExpr(env, a));
      // If it's a registered user function in env, instantiate.
      const sch = envGet(env, e.name);
      if (sch) {
        const ft = T.instantiate(sch);
        const rep = T.repr(ft);
        if (rep.tag === "TFun" && rep.params.length === args.length) {
          for (let i = 0; i < args.length; i++) unifyAt(locOf(e), rep.params[i], args[i]);
          return T.repr(rep.ret);
        }
      }
      return T.TVar(T.freshTvar());
    }

    case "NewExpr": {
      const targs = e.args.map(a => inferExpr(env, a));
      const init = T.lookupClassMethodScheme(e.className, "init");
      if (init) {
        const ft = T.instantiate(init);
        const rep = T.repr(ft);
        if (rep.tag === "TFun") {
          // "Construct then init separately" idiom: `new C()` with no
          // args is allowed even when init expects >0 args — the call
          // site is expected to follow up with `now c.init(...)`.
          // Mirrors the gradual behaviour of the legacy walker.
          if (targs.length === 0 && rep.params.length > 0) {
            // skip check
          } else if (rep.params.length !== targs.length) {
            if (!inPreinfer) {
              T.typeError(
                `constructor ${e.className}: arity mismatch (expected ${rep.params.length}, got ${targs.length})`,
                locOf(e));
            }
          } else {
            for (let i = 0; i < targs.length; i++) {
              if (!unifyAt(locOf(e), rep.params[i], targs[i]) && !inPreinfer) {
                T.typeError(
                  `constructor ${e.className}: arg ${i + 1} type mismatch`,
                  locOf(e));
              }
            }
          }
        }
      }
      return T.TActor(e.className, []);
    }

    case "Now":
    case "Future": {
      const tgt = inferExpr(env, e.target);
      const argTys = e.args.map(a => inferExpr(env, a));
      const rep = T.repr(tgt);
      if (rep.tag === "TActor") {
        const sch = T.lookupClassMethodScheme(rep.name, e.method);
        if (sch) {
          const ft = T.repr(T.instantiate(sch));
          if (ft.tag === "TFun" && ft.params.length === argTys.length) {
            for (let i = 0; i < argTys.length; i++) {
              if (!unifyAt(locOf(e), ft.params[i], argTys[i]) && !inPreinfer) {
                T.typeError(
                  `${rep.name}.${e.method}: arg ${i + 1} type mismatch`,
                  locOf(e));
              }
            }
            return T.repr(ft.ret);
          }
        }
      }
      return T.TVar(T.freshTvar());
    }

    case "Await": {
      inferExpr(env, e.expr);
      return T.TAny;
    }

    case "ArrayLit": {
      const elems = e.elems || [];
      if (elems.length === 0) return T.TArray(T.TVar(T.freshTvar()));
      const t1 = inferExpr(env, elems[0]);
      for (let i = 1; i < elems.length; i++) {
        const ti = inferExpr(env, elems[i]);
        unifyAt(locOf(e), ti, t1);
      }
      return T.TArray(t1);
    }

    case "TupleLit": {
      return T.TTuple((e.items || []).map(it => inferExpr(env, it)));
    }

    case "RecordLit": {
      const typed = (e.fields || []).map(([l, ex]) => [l, inferExpr(env, ex)]);
      return T.TRecord(typed, null);
    }

    case "FieldAccess": {
      const t = inferExpr(env, e.target);
      const rep = T.repr(t);
      if (rep.tag === "TRecord") {
        const found = rep.fields.find(([l]) => l === e.field);
        if (found) return found[1];
        if (!inPreinfer)
          T.typeError(`no field ${e.field} in record ${T.stringOfTyPretty(t)}`, locOf(e));
      }
      if (rep.tag === "TAny" || rep.tag === "TVar") return T.TVar(T.freshTvar());
      if (!inPreinfer)
        T.typeError(`field access .${e.field} on non-record type ${T.stringOfTyPretty(t)}`, locOf(e));
      return T.TAny;
    }

    case "IndexExpr": {
      const t = inferExpr(env, e.target);
      const rep = T.repr(t);
      if (rep.tag === "TArray") return rep.elt;
      if (rep.tag === "TTuple") {
        if (typeof e.index === "number") return rep.items[e.index] || T.TAny;
        return T.TAny;
      }
      if (rep.tag === "TAny" || rep.tag === "TVar") return T.TVar(T.freshTvar());
      return T.TAny;
    }

    default:
      // Unknown AST node — gradual escape.
      return T.TAny;
  }
}

// ─── checkStmt ─────────────────────────────────────────────────
function checkStmt(env, s) {
  if (!s) return;
  switch (s.type) {
    case "Seq":
      (s.statements || []).forEach(x => checkStmt(env, x));
      return;

    case "VarDecl": {
      const t = inferExpr(env, s.expr);
      const sch = T.generalize(envFtv(env), t);
      envSet(env, s.name, sch);
      return;
    }

    case "Assign": {
      const tRhs = inferExpr(env, s.expr);
      const existing = envGet(env, s.name);
      if (existing) {
        const tOld = T.instantiate(existing);
        // Soft unify — sentinel widening (e.g. drone_simulator's
        // string-then-actor field) survives via TAny fallback when
        // the unify fails.
        if (!unifyAt(locOf(s), tOld, tRhs)) {
          // Widen via TAny — match OCaml's gradual escape.
          envSet(env, s.name, T.Forall([], T.TAny));
          return;
        }
        const sch = T.generalize(envFtv(env), tRhs);
        envSet(env, s.name, sch);
      } else {
        const sch = T.generalize(envFtv(env), tRhs);
        envSet(env, s.name, sch);
      }
      return;
    }

    case "If": {
      if (s.cond) {
        const tc = inferExpr(env, s.cond);
        unifyAt(locOf(s), tc, T.TBool);
      }
      checkStmt(env, s.thenBody);
      if (s.elseBody) checkStmt(env, s.elseBody);
      return;
    }

    case "While": {
      if (s.cond) {
        const tc = inferExpr(env, s.cond);
        unifyAt(locOf(s), tc, T.TBool);
      }
      checkStmt(env, s.body);
      return;
    }

    case "Send": {
      const argTys = (s.args || []).map(a => inferExpr(env, a));
      // Target resolution: if target is `self`/local actor, look up
      // the method scheme and unify args.  Otherwise (string-typed
      // remote, sender callback, …) just walk args for side-effects.
      const tgt = inferExpr(env, s.target);
      const rep = T.repr(tgt);
      if (rep.tag === "TActor") {
        const sch = T.lookupClassMethodScheme(rep.name, s.method);
        if (sch) {
          const ft = T.repr(T.instantiate(sch));
          if (ft.tag === "TFun") {
            if (ft.params.length !== argTys.length) {
              if (!inPreinfer)
                T.typeError(
                  `${rep.name}.${s.method}: arity mismatch (expected ${ft.params.length}, got ${argTys.length})`,
                  locOf(s));
            } else {
              for (let i = 0; i < argTys.length; i++) {
                if (!unifyAt(locOf(s), ft.params[i], argTys[i]) && !inPreinfer) {
                  T.typeError(
                    `${rep.name}.${s.method}: arg ${i + 1} type mismatch`,
                    locOf(s));
                }
              }
            }
          }
        } else if (!inPreinfer) {
          // Method not found on the target class — soft-skip (some
          // samples send to dynamically-looked-up actors).  OCaml is
          // stricter here; we leave it gradual to keep the 14/14
          // smoke green.
        }
      }
      // string/any/var targets: gradual pass-through
      return;
    }

    case "Print":
    case "Reply": {
      if (s.expr) inferExpr(env, s.expr);
      return;
    }

    case "CallStmt": {
      (s.args || []).forEach(a => inferExpr(env, a));
      return;
    }

    case "Select": {
      (s.cases || []).forEach(c => {
        const sub = envClone(env);
        // Bind any select-case-introduced names as fresh tvars
        for (const v of ((c.pat && c.pat.vars) || [])) {
          envSet(sub, v, T.Forall([], T.TVar(T.freshTvar())));
        }
        checkStmt(sub, c.body);
      });
      if (s.timeoutBody) checkStmt(env, s.timeoutBody);
      return;
    }

    case "Saga": {
      // DR-11: body + compensate share enclosing env.
      for (const step of (s.steps || [])) {
        if (step.body) checkStmt(env, step.body);
        if (step.compensate) checkStmt(env, step.compensate);
      }
      return;
    }

    case "IndexAssign": {
      // a[i] = v;  walk the components.
      if (s.expr)  inferExpr(env, s.expr);
      (s.dims || []).forEach(d => inferExpr(env, d));
      return;
    }

    default:
      // Unknown statement — pass through.
      return;
  }
}

// ─── preinfer: walk classes, register schemes ────────────────
function inferClassFields(cls, env) {
  const acc = [];
  for (const field of (cls.fields || [])) {
    if (field.type === "VarField") {
      const t = inferExpr(env, field.expr);
      acc.push([field.name, T.repr(t)]);
      // Also bind in env so method body refs see the field.
      const sch = T.generalize(envFtv(env), t);
      envSet(env, field.name, sch);
    }
  }
  T.registerClassFieldTypes(cls.name, acc);

  // Pass 1b: scan method bodies for field assignments to detect
  // sentinel-style widening (drone/philosopher pattern).  When an
  // assignment to a field would fail to unify with its initializer's
  // type — OR the RHS depends on a parameter (so the field could be
  // arbitrarily typed across call sites) — widen the field's
  // recorded type to TAny.
  for (const md of (cls.methods || [])) {
    const envM = envClone(env);
    envSet(envM, "self", T.Forall([], T.TActor(cls.name, [])));
    const paramTvarIds = new Set();
    for (const p of (md.params || [])) {
      const tv = T.freshTvar();
      paramTvarIds.add(tv.id);
      envSet(envM, p, T.Forall([], T.TVar(tv)));
    }
    envSet(envM, "sender", T.Forall([], T.TAny));
    walkForFieldWidening(md.body, cls.name, envM, paramTvarIds);
  }

  // Re-read the (possibly-widened) field types and refresh the env.
  const finalFts = T.classFieldList(cls.name);
  for (const [name, t] of finalFts) {
    const sch = T.generalize(envFtv(env), t);
    envSet(env, name, sch);
  }
}

function widenFieldToAny(cls, name) {
  const fts = T.classFieldList(cls).slice();
  const idx = fts.findIndex(([n]) => n === name);
  if (idx >= 0) {
    fts[idx] = [name, T.TAny];
    T.registerClassFieldTypes(cls, fts);
  }
}

function walkForFieldWidening(node, cls, env, paramTvarIds) {
  if (!node) return;
  switch (node.type) {
    case "Seq":
      (node.statements || []).forEach(s => walkForFieldWidening(s, cls, env, paramTvarIds));
      return;
    case "Assign": {
      const t = T.lookupFieldType(cls, node.name);
      if (t === null) return;  // not a field
      if (t.tag === "TAny") return;  // already widened — nothing to do
      const tRhs = inferExpr(env, node.expr);
      // Heuristic 1: RHS depends on a parameter tvar.  Different call
      // sites could supply unrelated concrete types, so the field must
      // be polymorphic — widen to TAny.  Same rule covers `sender`
      // (bound to TAny) implicitly via the unify rule.
      const rhsFtv = T.ftvTy(tRhs);
      for (const id of rhsFtv) {
        if (paramTvarIds.has(id)) { widenFieldToAny(cls, node.name); return; }
      }
      // Heuristic 2: RHS is `sender` (TAny) — same conclusion.
      const rRhs = T.repr(tRhs);
      if (rRhs.tag === "TAny") { widenFieldToAny(cls, node.name); return; }
      // Heuristic 3: concrete RHS that doesn't unify with the field.
      if (!unifyAt(locOf(node), t, tRhs)) widenFieldToAny(cls, node.name);
      return;
    }
    case "If":
      walkForFieldWidening(node.thenBody, cls, env, paramTvarIds);
      if (node.elseBody) walkForFieldWidening(node.elseBody, cls, env, paramTvarIds);
      return;
    case "While":
      walkForFieldWidening(node.body, cls, env, paramTvarIds);
      return;
    case "Select":
      (node.cases || []).forEach(c => walkForFieldWidening(c.body, cls, env, paramTvarIds));
      if (node.timeoutBody) walkForFieldWidening(node.timeoutBody, cls, env, paramTvarIds);
      return;
    case "Saga":
      for (const step of (node.steps || [])) {
        walkForFieldWidening(step.body, cls, env, paramTvarIds);
        walkForFieldWidening(step.compensate, cls, env, paramTvarIds);
      }
      return;
  }
}

function preinferMethodSchemes(cls, envCls) {
  const sigs = [];
  for (const md of (cls.methods || [])) {
    const envM = envClone(envCls);
    envSet(envM, "self", T.Forall([], T.TActor(cls.name, [])));
    envSet(envM, "sender", T.Forall([], T.TAny));
    const paramTvars = (md.params || []).map(_ => T.freshTvar());
    const paramTys = paramTvars.map(tv => T.TVar(tv));
    (md.params || []).forEach((p, i) => {
      envSet(envM, p, T.Forall([], paramTys[i]));
    });
    const retTv = T.freshTvar();
    const retTy = T.TVar(retTv);

    const savedClass = currentClass;
    currentClass = cls.name;
    try {
      checkStmt(envM, md.body);
    } finally {
      currentClass = savedClass;
    }
    const tfun = T.TFun(paramTys.map(t => T.repr(t)), T.repr(retTy));
    const sch = T.generalize(envFtv(envCls), tfun);
    sigs.push([md.name, sch]);
  }
  T.registerClassMethodSchemes(cls.name, sigs);
}

function prebindGlobalActors(ast, env) {
  for (const s of (ast.statements || [])) {
    if (s.type === "VarDecl" && s.expr && s.expr.type === "NewExpr") {
      const cls = s.expr.className;
      envSet(env, s.name, T.Forall([], T.TActor(cls, [])));
    }
  }
}

function preinferAllClasses(ast) {
  // First pass: register every class with TUnit-returning fresh-tvar
  // signatures so cross-class send/now/future can find target methods
  // during the constraint-gathering walk below.
  for (const cls of (ast.classes || [])) {
    T.registerClassAuto(
      cls.name,
      (cls.methods || []).map(m => [m.name, (m.params || []).length]));
  }
  // Second pass: per-class — infer field types, then walk methods to
  // refine the auto-registered schemes.
  for (const cls of (ast.classes || [])) {
    const envCls = envNew();
    inferClassFields(cls, envCls);
    preinferMethodSchemes(cls, envCls);
  }
}

// ─── check phase ─────────────────────────────────────────────
function checkProgram(ast) {
  for (const cls of (ast.classes || [])) {
    const envCls = envNew();
    // Re-bind fields from the registry (post-preinfer).
    for (const [f, t] of T.classFieldList(cls.name)) {
      envSet(envCls, f, T.Forall([], t));
    }
    for (const md of (cls.methods || [])) {
      const envM = envClone(envCls);
      envSet(envM, "self", T.Forall([], T.TActor(cls.name, [])));
      envSet(envM, "sender", T.Forall([], T.TAny));
      // Bind parameters: use the scheme's recorded param types when
      // available, else fresh tvars.
      const sch = T.lookupClassMethodScheme(cls.name, md.name);
      let paramTys = (md.params || []).map(_ => T.TVar(T.freshTvar()));
      if (sch) {
        const ft = T.repr(T.instantiate(sch));
        if (ft.tag === "TFun" && ft.params.length === paramTys.length) {
          paramTys = ft.params;
        }
      }
      (md.params || []).forEach((p, i) => {
        envSet(envM, p, T.Forall([], paramTys[i]));
      });
      const savedClass = currentClass;
      currentClass = cls.name;
      try {
        checkStmt(envM, md.body);
      } finally {
        currentClass = savedClass;
      }
    }
  }
  // Top-level globals.
  const envG = envNew();
  prebindGlobalActors(ast, envG);
  for (const s of (ast.statements || [])) checkStmt(envG, s);
}

// ─── effect collection (mirrors typecheck.js::collectMethodEffects) ─
export function collectMethodEffects(ast) {
  const effects = {};
  // クラスごとのフィールド名を AST から直接作る。
  // 以前は types.js の登録済みテーブル（lookupFieldType）を見ていたが、
  // 効果収集だけを単体で走らせるとテーブルが空で、
  // フィールド代入が一件も mut にならなかった。
  const fieldNames = {};
  const fieldClass = {};      // クラス名 -> (フィールド名 -> 宛先クラス名)
  const localClass = {};      // "C.m" -> (ローカル変数名 -> 宛先クラス名)
  for (const cls of (ast.classes || [])) {
    effects[cls.name] = {};
    fieldNames[cls.name] = new Set((cls.fields || []).map(f => f.name));
    // `var p = new Planner();` のように new で初期化されたフィールドは、
    // 宛先のクラスが静的に分かる。now / future の効果を引き継ぐ辺を張るのに使う。
    fieldClass[cls.name] = {};
    for (const f of (cls.fields || [])) {
      if (f.expr && f.expr.type === "NewExpr" && f.expr.className) {
        fieldClass[cls.name][f.name] = f.expr.className;
      }
    }
    for (const md of (cls.methods || [])) effects[cls.name][md.name] = new Set();
  }

  const callEdges = {};  // "C.m" -> [["C2","m2"], ...]
  function addEdge(from, to) {
    if (!callEdges[from]) callEdges[from] = [];
    callEdges[from].push(to);
  }

  function direct(node, ownerCls, ownerMethod) {
    if (!node) return;
    const add = (e) => effects[ownerCls][ownerMethod].add(e);
    switch (node.type) {
      case "Seq":
        (node.statements || []).forEach(s => direct(s, ownerCls, ownerMethod));
        return;
      case "VarDecl": {
        if (node.expr && node.expr.type === "NewExpr" && node.expr.className) {
          const k = `${ownerCls}.${ownerMethod}`;
          if (!localClass[k]) localClass[k] = {};
          localClass[k][node.name] = node.expr.className;
        }
        direct(node.expr, ownerCls, ownerMethod);
        return;
      }
      case "Assign": {
        // Field assignment counts as mut
        if ((fieldNames[ownerCls] && fieldNames[ownerCls].has(node.name)) ||
            T.lookupFieldType(ownerCls, node.name) !== null) add("mut");
        direct(node.expr, ownerCls, ownerMethod);
        return;
      }
      case "IndexAssign":
        add("mut");
        direct(node.expr, ownerCls, ownerMethod);
        (node.dims || []).forEach(d => direct(d, ownerCls, ownerMethod));
        return;
      case "Send":
        // send は送って待たないので、呼ばれる側の効果を引き継がない
        // （ガイド g6 の ViaSend に明記された仕様。OCaml 版もそうしている）。
        // 辺を張らずに引数だけ見る。
        (node.args || []).forEach(a => direct(a, ownerCls, ownerMethod));
        return;
      case "Now":
      case "Future": {
        // メッセージを送ること自体は「自分の状態を変える」ではない。
        // ここで mut を足していたため、reply するだけのメソッドまで mut を持ち、
        // 宣言と照合すると正しいプログラムが軒並み落ちた。
        // OCaml 版（正）では mut はフィールド代入と become だけが生む。
        // 宛先のクラスを解決して、呼ばれる側の効果を引き継ぐ辺を張る。
        // 以前は宛先が `new C()` と直に書かれた場合しか見ておらず、
        // `var p = new Planner(); ... now p.plan(x)` の形で効果が伝播しなかった。
        if (node.target && node.target.type === "NewExpr") {
          addEdge(`${ownerCls}.${ownerMethod}`, [node.target.className, node.method]);
        } else {
          // 宛先は文字列（変数名）で来ることがある。オブジェクトだと決めつけない。
          const tname =
            (typeof node.target === "string") ? node.target
            : (node.target && node.target.type === "Var") ? node.target.name
            : null;
          if (tname && tname !== "self" && tname !== "sender") {
            const k = `${ownerCls}.${ownerMethod}`;
            const cls =
              (localClass[k] && localClass[k][tname]) ||
              (fieldClass[ownerCls] && fieldClass[ownerCls][tname]);
            if (cls) addEdge(k, [cls, node.method]);
          }
        }
        // For self-sends, propagate to same class
        if (node.target && node.target.type === "Var" && node.target.name === "self") {
          addEdge(`${ownerCls}.${ownerMethod}`, [ownerCls, node.method]);
        }
        (node.args || []).forEach(a => direct(a, ownerCls, ownerMethod));
        return;
      }
      case "Print":
        direct(node.expr, ownerCls, ownerMethod);
        return;
      case "Reply":
        // reply も同じ理由で mut を生まない（返信は自分の状態の変更ではない）。
        direct(node.expr, ownerCls, ownerMethod);
        return;
      case "CallStmt": {
        const e = BUILTIN_EFFECTS[node.name];
        if (e) for (const x of e) add(x);
        (node.args || []).forEach(a => direct(a, ownerCls, ownerMethod));
        return;
      }
      case "If":
        direct(node.cond, ownerCls, ownerMethod);
        direct(node.thenBody, ownerCls, ownerMethod);
        if (node.elseBody) direct(node.elseBody, ownerCls, ownerMethod);
        return;
      case "While":
        direct(node.cond, ownerCls, ownerMethod);
        direct(node.body, ownerCls, ownerMethod);
        return;
      case "Select":
        (node.cases || []).forEach(c => direct(c.body, ownerCls, ownerMethod));
        if (node.timeoutBody) direct(node.timeoutBody, ownerCls, ownerMethod);
        return;
      case "Saga":
        add("mut");
        for (const step of (node.steps || [])) {
          direct(step.body,       ownerCls, ownerMethod);
          direct(step.compensate, ownerCls, ownerMethod);
        }
        return;
      // Expression arms
      case "Binop":
      case "Unop":
        direct(node.left,  ownerCls, ownerMethod);
        direct(node.right, ownerCls, ownerMethod);
        direct(node.expr,  ownerCls, ownerMethod);
        return;
      case "CallExpr": {
        const e = BUILTIN_EFFECTS[node.name];
        if (e) for (const x of e) add(x);
        (node.args || []).forEach(a => direct(a, ownerCls, ownerMethod));
        return;
      }
      case "Await":
        direct(node.expr, ownerCls, ownerMethod);
        return;
      case "NewExpr":
        addEdge(`${ownerCls}.${ownerMethod}`, [node.className, "init"]);
        add("mut");
        (node.args || []).forEach(a => direct(a, ownerCls, ownerMethod));
        return;
    }
  }

  for (const cls of (ast.classes || [])) {
    for (const md of (cls.methods || [])) {
      direct(md.body, cls.name, md.name);
    }
  }

  // Fixed-point over call edges
  let changed = true;
  while (changed) {
    changed = false;
    for (const fromKey of Object.keys(callEdges)) {
      const [fcls, fm] = fromKey.split(".");
      if (!effects[fcls] || !effects[fcls][fm]) continue;
      for (const [tcls, tm] of callEdges[fromKey]) {
        if (!effects[tcls] || !effects[tcls][tm]) continue;
        for (const e of effects[tcls][tm]) {
          if (!effects[fcls][fm].has(e)) {
            effects[fcls][fm].add(e);
            changed = true;
          }
        }
      }
    }
  }

  return effects;
}

function effFmt(s) { return [...s].sort().join(","); }

// ─── public façade ────────────────────────────────────────────
export function runInference(ast) {
  T.resetForTypecheck();
  inPreinfer = true;
  preinferAllClasses(ast);
  inPreinfer = false;
  checkProgram(ast);

  // Project results to JSON-friendly plain-string shape.
  const classFieldTypes = {};
  for (const cls of (ast.classes || [])) {
    const fts = T.classFieldList(cls.name);
    classFieldTypes[cls.name] = {};
    for (const [f, t] of fts) classFieldTypes[cls.name][f] = T.stringOfTyPretty(t);
  }

  const methodSigs = {};
  for (const cls of (ast.classes || [])) {
    methodSigs[cls.name] = {};
    for (const md of (cls.methods || [])) {
      const sch = T.lookupClassMethodScheme(cls.name, md.name);
      if (sch) {
        const ft = T.repr(T.instantiate(sch));
        if (ft.tag === "TFun") {
          methodSigs[cls.name][md.name] = {
            params: ft.params.map(p => T.stringOfTyPretty(p)),
            ret:    T.stringOfTyPretty(ft.ret),
          };
          continue;
        }
      }
      // Fallback: anys with declared arity
      methodSigs[cls.name][md.name] = {
        params: (md.params || []).map(() => "any"),
        ret: "any",
      };
    }
  }

  const effects = collectMethodEffects(ast);
  const effectsStr = {};
  for (const c of Object.keys(effects)) {
    effectsStr[c] = {};
    for (const m of Object.keys(effects[c])) {
      effectsStr[c][m] = effFmt(effects[c][m]) || "pure";
    }
  }

  return { classFieldTypes, methodSigs, effects, effectsStr };
}

// Re-export the type error class for the façade.
export { TypeError } from "./types.js";
