// types.js — Hindley-Milner type system for JS-B / JS-N AIPL.
//
// 1:1 port of src/types.ml.  Covers Phase 1-3 of the JS HM upgrade:
//   - tagged ty ADT + refinement predicates
//   - fresh tvar / scheme var generators
//   - repr (path compression) + occurs check
//   - unify (with row-poly + refinement opt-ins, matching OCaml)
//   - generalize / instantiate / prune / ftv
//   - class method scheme + class field type + local var registries
//
// Public exports parallel ocaml-side names in camelCase:
//   freshTvar, freshSchemeVar, freshes, repr, prune, occurs,
//   unify, ftvTy, generalize, instantiate, stringOfTy,
//   stringOfTyPretty, lookupMethodType, lookupClassMethodsInst,
//   register/lookup tables, resetForTypecheck, TypeError.
//
// JS-B uses globalThis.AIPL_ROWPOLY / globalThis.AIPL_REFINE_UNIFY
// for env-var-style opt-ins (Node sets them via process.env at boot).

// ─── exceptions ─────────────────────────────────────────────────
export class TypeError extends Error {
  constructor(msg, loc) {
    super(msg);
    this.name = "TypeError";
    this.loc = loc || null;
  }
}

export function typeError(msg, loc) {
  throw new TypeError(msg, loc);
}

function locEq(a, b) {
  return a === b;
}
const DUMMY_LOC = null;

// ─── env-var helpers ────────────────────────────────────────────
function envFlag(name) {
  if (typeof globalThis !== "undefined" && globalThis[name] === "1") return true;
  if (typeof process !== "undefined" && process.env && process.env[name] === "1") return true;
  return false;
}

// ─── refinement predicate AST (mirror of types.ml `refine_pred`) ─
export const RP = {
  Int:    (n)            => ({ tag: "RpInt",    n }),
  Float:  (x)            => ({ tag: "RpFloat",  x }),
  Var:    (name)         => ({ tag: "RpVar",    name }),
  Unary:  (op, p)        => ({ tag: "RpUnary",  op, p }),
  Binop:  (op, p1, p2)   => ({ tag: "RpBinop",  op, p1, p2 }),
  Paren:  (p)            => ({ tag: "RpParen",  p }),
};

// Refinement subset hook — populated by refinement.js (or by
// node-aipl-server in z3 mode).  Returns null on success / no opinion,
// or a string explaining the counter-example.
export let refinementCheckHook = (_base, _binder, _p1, _p2) => null;
export function setRefinementCheckHook(fn) { refinementCheckHook = fn; }

// ─── tvar + ty constructors ─────────────────────────────────────
let nextTvarId   = 0;
let nextSchemeId = 0;

export function freshTvar() {
  return { id: nextTvarId++, link: null };
}
export function freshSchemeVar() {
  return nextSchemeId++;
}
export function freshes(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(freshSchemeVar());
  return out;
}

// Singletons — frozen so accidental mutation throws in strict mode.
export const TInt    = Object.freeze({ tag: "TInt"    });
export const TFloat  = Object.freeze({ tag: "TFloat"  });
export const TString = Object.freeze({ tag: "TString" });
export const TBool   = Object.freeze({ tag: "TBool"   });
export const TUnit   = Object.freeze({ tag: "TUnit"   });
export const TAny    = Object.freeze({ tag: "TAny"    });

export function TVar(tv)               { return { tag: "TVar",    tv }; }
export function TFun(params, ret)      { return { tag: "TFun",    params, ret }; }
export function TActor(name, methods)  { return { tag: "TActor",  name, methods: methods || [] }; }
export function TArray(elt)            { return { tag: "TArray",  elt }; }
export function TRecord(fields, tail)  {
  return { tag: "TRecord", fields: fields || [], tail: tail || null };
}
export function TTuple(items)          { return { tag: "TTuple",  items }; }
export function TRefined(base, binder, pred) {
  return { tag: "TRefined", base, binder, pred };
}

// Scheme (Forall qs t)
export function Forall(qs, ty)         { return { tag: "Forall",  qs, ty }; }

// ─── repr / path compression ────────────────────────────────────
export function repr(t) {
  if (t && t.tag === "TVar") {
    const tv = t.tv;
    if (tv.link !== null) {
      const r = repr(tv.link);
      tv.link = r;             // path compression
      return r;
    }
    return t;
  }
  return t;
}

// ─── occurs check (uses TV object identity) ─────────────────────
export function occurs(tvObj, t) {
  const r = repr(t);
  switch (r.tag) {
    case "TVar":     return r.tv === tvObj;
    case "TArray":   return occurs(tvObj, r.elt);
    case "TRecord":
      for (const [, ft] of r.fields) if (occurs(tvObj, ft)) return true;
      if (r.tail && occurs(tvObj, r.tail)) return true;
      return false;
    case "TTuple":   return r.items.some(it => occurs(tvObj, it));
    case "TFun":
      return r.params.some(p => occurs(tvObj, p)) || occurs(tvObj, r.ret);
    case "TActor":
      return r.methods.some(([, mt]) => occurs(tvObj, mt));
    case "TRefined": return occurs(tvObj, r.base);
    default:         return false;
  }
}

// ─── unify ──────────────────────────────────────────────────────
// Mutual recursive; throws TypeError on mismatch.  The optional
// `loc` parameter carries source location for the error message.
export function unify(t1, t2, loc) {
  const a = repr(t1);
  const b = repr(t2);
  if (a === b) return;
  if (a.tag === "TAny" || b.tag === "TAny") return;

  if (a.tag === "TVar") return bindTvar(a.tv, b, loc);
  if (b.tag === "TVar") return bindTvar(b.tv, a, loc);

  if (a.tag !== b.tag) {
    // CE-12: refinement see-through
    if (a.tag === "TRefined") return unify(a.base, b, loc);
    if (b.tag === "TRefined") return unify(a, b.base, loc);
    typeError(`type mismatch: ${stringOfTyPretty(a)} vs ${stringOfTyPretty(b)}`, loc);
  }

  switch (a.tag) {
    case "TInt": case "TFloat": case "TBool":
    case "TString": case "TUnit":
      return;

    case "TActor":
      // Match OCaml: tag-equal TActor unifies trivially (method maps
      // are looked up via class_method_schemes, not the carried list).
      return;

    case "TArray":
      return unify(a.elt, b.elt, loc);

    case "TTuple":
      if (a.items.length !== b.items.length)
        typeError(`tuple arity mismatch (${a.items.length} vs ${b.items.length})`, loc);
      for (let i = 0; i < a.items.length; i++) unify(a.items[i], b.items[i], loc);
      return;

    case "TFun":
      if (a.params.length !== b.params.length)
        typeError(`arity mismatch (${a.params.length} vs ${b.params.length})`, loc);
      for (let i = 0; i < a.params.length; i++) unify(a.params[i], b.params[i], loc);
      unify(a.ret, b.ret, loc);
      return;

    case "TRecord":
      return unifyRecords(a, b, loc);

    case "TRefined": {
      unify(a.base, b.base, loc);
      if (envFlag("AIPL_REFINE_UNIFY")) {
        const why = refinementCheckHook({ base: a.base, binder: "x" }, "x", a.pred, b.pred);
        if (why) typeError(`refinement subtype check failed: ${why}`, loc);
      }
      return;
    }
    /* istanbul ignore next */
    default:
      typeError(`unify: unhandled tag ${a.tag}`, loc);
  }
}

function bindTvar(tv, t, loc) {
  // No-op when binding tv to itself
  const r = repr(t);
  if (r.tag === "TVar" && r.tv === tv) return;
  if (occurs(tv, t)) typeError("occurs check failed", loc);
  tv.link = t;
}

function unifyRecords(a, b, loc) {
  const s1 = a.fields.map(([l]) => l);
  const s2 = b.fields.map(([l]) => l);
  const common = s1.filter(l => s2.includes(l));
  const only1  = s1.filter(l => !s2.includes(l));
  const only2  = s2.filter(l => !s1.includes(l));
  const rowpoly =
    (a.tail || b.tail) && envFlag("AIPL_ROWPOLY");

  const lookup = (fields, key) => {
    const found = fields.find(([k]) => k === key);
    return found ? found[1] : null;
  };

  if (rowpoly) {
    for (const l of common) unify(lookup(a.fields, l), lookup(b.fields, l), loc);
    if (only1.length && !b.tail)
      typeError(`closed record on rhs cannot accept extra fields: ${only1.join(", ")}`, loc);
    if (only2.length && !a.tail)
      typeError(`closed record on lhs cannot accept extra fields: ${only2.join(", ")}`, loc);
    const f1 = only1.map(l => [l, lookup(a.fields, l)]);
    const f2 = only2.map(l => [l, lookup(b.fields, l)]);
    if (a.tail && b.tail) {
      const rest = TVar(freshTvar());
      unify(a.tail, TRecord(f2, rest), loc);
      unify(b.tail, TRecord(f1, rest), loc);
    } else if (a.tail) {
      unify(a.tail, TRecord(f2, null), loc);
    } else if (b.tail) {
      unify(b.tail, TRecord(f1, null), loc);
    }
  } else {
    // CE-13: width subtyping — intersection of labels must unify;
    // disjoint label sets are an error (mirrors types.ml line 329).
    if (common.length === 0 && a.fields.length > 0 && b.fields.length > 0)
      typeError(`record fields disjoint: [${s1.join(", ")}] vs [${s2.join(", ")}]`, loc);
    for (const l of common) unify(lookup(a.fields, l), lookup(b.fields, l), loc);
  }
}

// Soft-fail wrapper used at sentinel sites where pre-HM code relied
// on `any` widening.  Returns true on success, false if unify raised.
export function unifyTry(t1, t2, loc) {
  try { unify(t1, t2, loc); return true; }
  catch (e) {
    if (e instanceof TypeError) return false;
    throw e;
  }
}

// ─── prune (rewrites tree to remove resolved tvars) ─────────────
export function prune(t) {
  if (!t || typeof t !== "object") return t;
  switch (t.tag) {
    case "TVar": {
      const tv = t.tv;
      if (tv.link !== null) {
        const r = prune(tv.link);
        tv.link = r;
        return r;
      }
      return t;
    }
    case "TArray":   return TArray(prune(t.elt));
    case "TRecord":  return TRecord(t.fields.map(([l, ft]) => [l, prune(ft)]),
                                    t.tail ? prune(t.tail) : null);
    case "TTuple":   return TTuple(t.items.map(prune));
    case "TActor":   return TActor(t.name, t.methods.map(([m, mt]) => [m, prune(mt)]));
    case "TFun":     return TFun(t.params.map(prune), prune(t.ret));
    case "TRefined": return TRefined(prune(t.base), t.binder, t.pred);
    default:         return t;
  }
}

// ─── free type variables (returns Set<number>) ──────────────────
export function ftvTy(t) {
  const out = new Set();
  walkFtv(t, out);
  return out;
}
function walkFtv(t, out) {
  const r = repr(t);
  switch (r.tag) {
    case "TVar":     out.add(r.tv.id); return;
    case "TArray":   walkFtv(r.elt, out); return;
    case "TRecord":
      for (const [, ft] of r.fields) walkFtv(ft, out);
      if (r.tail) walkFtv(r.tail, out);
      return;
    case "TTuple":   r.items.forEach(it => walkFtv(it, out)); return;
    case "TFun":
      r.params.forEach(p => walkFtv(p, out));
      walkFtv(r.ret, out);
      return;
    case "TActor":   r.methods.forEach(([, mt]) => walkFtv(mt, out)); return;
    case "TRefined": walkFtv(r.base, out); return;
    default: return;
  }
}

// ─── generalize / instantiate ───────────────────────────────────
// `envFtv` is a Set<number> of tvar ids that are still mentioned by
// the surrounding env and therefore must NOT be quantified.
export function generalize(envFtv, t) {
  const ftv = ftvTy(t);
  const qs = [];
  for (const id of ftv) if (!envFtv.has(id)) qs.push(id);
  return Forall(qs, t);
}

// Replace each TVar whose id ∈ qs with a fresh tvar.
export function instantiate(scheme) {
  if (!scheme || scheme.tag !== "Forall")
    throw new Error("instantiate: not a scheme");
  const tbl = new Map();
  for (const q of scheme.qs) tbl.set(q, freshTvar());
  const inst = (ty) => {
    const r = ty;  // do NOT repr() here — we want to walk the raw structure
    switch (r.tag) {
      case "TInt": case "TFloat": case "TBool":
      case "TString": case "TUnit": case "TAny":
        return r;
      case "TArray":   return TArray(inst(r.elt));
      case "TRecord":  return TRecord(r.fields.map(([l, ft]) => [l, inst(ft)]),
                                       r.tail ? inst(r.tail) : null);
      case "TTuple":   return TTuple(r.items.map(inst));
      case "TActor":   return TActor(r.name, r.methods.map(([m, mt]) => [m, inst(mt)]));
      case "TFun":     return TFun(r.params.map(inst), inst(r.ret));
      case "TRefined": return TRefined(inst(r.base), r.binder, r.pred);
      case "TVar": {
        const fresh = tbl.get(r.tv.id);
        return fresh ? TVar(fresh) : r;
      }
      default: return r;
    }
  };
  return inst(scheme.ty);
}

// Free-tvars of a scheme: ftv(ty) - qs.
export function ftvScheme(scheme) {
  const out = ftvTy(scheme.ty);
  for (const q of scheme.qs) out.delete(q);
  return out;
}

// ─── pretty printers ────────────────────────────────────────────
export function stringOfTy(t) {
  const r = repr(t);
  switch (r.tag) {
    case "TInt":    return "int";
    case "TFloat":  return "float";
    case "TBool":   return "bool";
    case "TString": return "string";
    case "TUnit":   return "unit";
    case "TAny":    return "any";
    case "TActor": {
      const ms = r.methods.map(([m, mt]) => `${m} : ${stringOfTy(mt)}`).join("; ");
      return `actor(${r.name}) {${ms}}`;
    }
    case "TRecord": {
      const fs = r.fields.map(([l, ft]) => `${l} : ${stringOfTy(ft)}`).join("; ");
      const tailS = r.tail
        ? (r.fields.length ? "; " : "") + "| " + stringOfTy(r.tail)
        : "";
      return `{${fs}${tailS}}`;
    }
    case "TTuple":
      return "(" + r.items.map(stringOfTy).join(" * ") + ")";
    case "TArray":
      return `${stringOfTy(r.elt)} array`;
    case "TFun": {
      const ps = r.params.length === 0
        ? "()"
        : "(" + r.params.map(stringOfTy).join(" * ") + ")";
      return `${ps} -> ${stringOfTy(r.ret)}`;
    }
    case "TVar":
      return `'a${r.tv.id}`;
    case "TRefined":
      return `${stringOfTy(r.base)} where <${r.binder}>`;
    default:
      return `<${r.tag}>`;
  }
}

// Pretty version: rename tvar ids to 'a, 'b, ... per term.
export function stringOfTyPretty(t) {
  const names = new Map();
  let n = 0;
  const nameOf = (id) => {
    if (names.has(id)) return names.get(id);
    const base = String.fromCharCode("a".charCodeAt(0) + (n % 26));
    const suffix = Math.floor(n / 26);
    n++;
    const nm = suffix === 0 ? `'${base}` : `'${base}${suffix}`;
    names.set(id, nm);
    return nm;
  };
  const go = (ty) => {
    const r = prune(ty);
    switch (r.tag) {
      case "TVar":    return nameOf(r.tv.id);
      case "TArray":  return go(r.elt) + "[]";
      case "TRecord": {
        const body = r.fields.map(([l, ft]) => `${l} : ${go(ft)}`).join("; ");
        const tailS = r.tail
          ? (r.fields.length ? "; " : "") + "| " + go(r.tail)
          : "";
        return `{${body}${tailS}}`;
      }
      case "TTuple":
        return "(" + r.items.map(go).join(" * ") + ")";
      case "TActor": {
        const ms = r.methods.map(([m, mt]) => `${m} : ${go(mt)}`).join("; ");
        return `actor(${r.name}) { ${ms} }`;
      }
      case "TFun": {
        const ps = r.params.length === 0
          ? "()"
          : "(" + r.params.map(go).join(" * ") + ")";
        return `${ps} -> ${go(r.ret)}`;
      }
      case "TInt":    return "int";
      case "TFloat":  return "float";
      case "TBool":   return "bool";
      case "TString": return "string";
      case "TUnit":   return "unit";
      case "TAny":    return "any";
      case "TRefined": return `${go(r.base)} where <${r.binder}>`;
      default: return `<${r.tag}>`;
    }
  };
  return go(t);
}

// Look up a method type from a receiver type.
export function lookupMethodType(tobj, mname) {
  const r = repr(tobj);
  if (r.tag === "TActor") {
    const found = r.methods.find(([m]) => m === mname);
    return found ? found[1] : null;
  }
  if (r.tag === "TRecord") {
    const found = r.fields.find(([l]) => l === mname);
    return found ? found[1] : null;
  }
  return null;
}

// ─── registries (mirror OCaml's Hashtbls) ───────────────────────
const classMethodSchemes = new Map();   // class -> Array<[method, scheme]>
const classFieldTypes    = new Map();   // class -> Array<[field, ty]>
const localVarTypes      = new Map();   // key  -> ty   (key = `${cls}|${m}|${var}`)

function locKey(cls, mname, name) { return `${cls}|${mname}|${name}`; }

export function registerClassMethodSchemes(cls, sigs) {
  classMethodSchemes.set(cls, sigs.slice());
}
export function registerClass(cls, sigs) {
  classMethodSchemes.set(cls, sigs.slice());
}
export function registerClassAuto(cls, methodsArity) {
  const sigs = methodsArity.map(([m, arity]) => {
    const tvars = [];
    for (let i = 0; i < arity; i++) tvars.push(freshTvar());
    const qs = tvars.map(tv => tv.id);
    const params = tvars.map(tv => TVar(tv));
    return [m, Forall(qs, TFun(params, TUnit))];
  });
  classMethodSchemes.set(cls, sigs);
}
export function lookupMethodScheme(cls, mname) {
  const sigs = classMethodSchemes.get(cls);
  if (!sigs) return null;
  const found = sigs.find(([m]) => m === mname);
  return found ? found[1] : null;
}
export function lookupClassMethodScheme(cls, mname) {
  return lookupMethodScheme(cls, mname);
}
export function classMethodList(cls) {
  return classMethodSchemes.get(cls) || [];
}
export function lookupClassMethodsInst(cls) {
  const sigs = classMethodSchemes.get(cls) || [];
  return sigs.map(([m, sch]) => [m, repr(instantiate(sch))]);
}

export function registerClassFieldTypes(cls, fts) {
  classFieldTypes.set(cls, fts.slice());
}
export function lookupFieldType(cls, fname) {
  const fts = classFieldTypes.get(cls);
  if (!fts) return null;
  const found = fts.find(([f]) => f === fname);
  return found ? found[1] : null;
}
export function classFieldList(cls) {
  return classFieldTypes.get(cls) || [];
}

export function registerLocalType(cls, mname, name, t) {
  localVarTypes.set(locKey(cls, mname, name), t);
}
export function lookupLocalType(cls, mname, name) {
  return localVarTypes.get(locKey(cls, mname, name)) || null;
}

export function clearFieldAndLocalTypes() {
  classFieldTypes.clear();
  localVarTypes.clear();
}

export function resetForTypecheck() {
  classFieldTypes.clear();
  localVarTypes.clear();
  classMethodSchemes.clear();
  nextTvarId = 0;
  nextSchemeId = 0;
}

// ─── env helper: ftv of a tenv (Map<string, scheme[]>) ──────────
export function ftvEnv(env) {
  const out = new Set();
  for (const schemes of env.values()) {
    for (const sch of schemes) {
      const f = ftvScheme(sch);
      for (const id of f) out.add(id);
    }
  }
  return out;
}

// Debug
export function debugPrintClassMethodSchemes() {
  console.log("[class_method_schemes]");
  for (const [cls, sigs] of classMethodSchemes) {
    console.log(`class ${cls}`);
    for (const [m, sch] of sigs) {
      const ty = repr(instantiate(sch));
      console.log(`  ${m} : ${stringOfTyPretty(ty)}`);
    }
  }
}
