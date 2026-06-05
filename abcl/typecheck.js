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
