// Worker-side runner: one AIPL actor per Web Worker thread.
//
// Receives from main:
//   { kind: "init",     name, className, methods, fields, initArgs }
//   { kind: "deliver",  method, args, senderName }
//
// Posts to main:
//   { kind: "send",     from, target, method, args, unsafe }
//   { kind: "primCall", name, args }      // fire-and-forget builtin
//   { kind: "log",      message }
//   { kind: "reply",    value }            // unused for now (no now/future in workers yet)

let myName = null;
let myClass = null;
let methods = new Map();
let state = {};
const mailbox = [];
let processing = false;

function log(m) { self.postMessage({ kind: "log", message: m }); }

self.onmessage = async (ev) => {
  const msg = ev.data;
  switch (msg.kind) {
    case "init":
      myName  = msg.name;
      myClass = msg.className;
      methods = new Map((msg.methods || []).map(m => [m.name, m]));
      state = {};
      for (const f of (msg.fields || [])) {
        try { state[f.name] = await evalExpr(f.expr, {}); }
        catch { state[f.name] = 0; }
      }
      if (methods.has("init")) {
        mailbox.push({ method: "init", args: msg.initArgs || [], senderName: null });
        pumpMailbox();
      }
      break;
    case "deliver":
      mailbox.push({ method: msg.method, args: msg.args || [], senderName: msg.senderName || null });
      pumpMailbox();
      break;
  }
};

async function pumpMailbox() {
  if (processing) return;
  processing = true;
  while (mailbox.length > 0) {
    const m = mailbox.shift();
    const method = methods.get(m.method);
    if (!method) continue;
    const env = { __currentActor: myName, sender: m.senderName, ...state };
    method.params.forEach((p, i) => { env[p] = m.args[i]; });
    try {
      await runStmts(method.body.statements, env);
    } catch (e) {
      log(`[ERROR in ${myName}.${m.method}] ${e.message}`);
    }
    // Sync mutated state back to actor instance state
    for (const k of Object.keys(state)) if (k in env) state[k] = env[k];
  }
  processing = false;
}

async function runStmts(stmts, env) {
  for (const st of stmts) await runStmt(st, env);
}

async function runStmt(st, env) {
  switch (st.type) {
    case "Print":
      log(String(await evalExpr(st.expr, env)));
      return;

    case "VarDecl":
      env[st.name] = await evalExpr(st.expr, env);
      return;

    case "Assign":
      env[st.name] = await evalExpr(st.expr, env);
      return;

    case "Reply":
      // For now: forward as primCall. Reply slots for now/future are not
      // wired through the worker boundary yet.
      self.postMessage({ kind: "reply", value: await evalExpr(st.expr, env) });
      return;

    case "Send": {
      const args = [];
      for (const a of st.args) args.push(await evalExpr(a, env));
      const tgt = resolveTarget(st.target, env);
      self.postMessage({
        kind: "send", from: myName, target: tgt,
        method: st.method, args, unsafe: !!st.unsafe,
      });
      return;
    }

    case "CallStmt": {
      const args = [];
      for (const a of st.args) args.push(await evalExpr(a, env));
      if (st.name === "wait") {
        const ms = Number(args[0]) || 0;
        await new Promise(r => setTimeout(r, ms));
      } else {
        // forward to main as a fire-and-forget primCall
        self.postMessage({ kind: "primCall", name: st.name, args });
      }
      return;
    }

    case "If": {
      const c = await evalExpr(st.cond, env);
      if (c) await runStmts(st.thenBody.statements, env);
      else if (st.elseBody) await runStmts(st.elseBody.statements, env);
      return;
    }

    default:
      log(`[worker ${myName}] unsupported stmt: ${st.type}`);
  }
}

function resolveTarget(t, env) {
  if (typeof t !== "string") return null;
  if (t === "self") return myName;
  if (t === "sender") return env.sender;
  if (t in env) return env[t];
  return t;
}

async function evalExpr(e, env) {
  if (!e) return null;
  switch (e.type) {
    case "IntLit":   return e.value;
    case "FloatLit": return e.value;
    case "StringLit": return e.value;
    case "Var":
      if (e.name in env) return env[e.name];
      throw new Error("Unknown var in worker: " + e.name);
    case "Binop": {
      const l = await evalExpr(e.left, env);
      const r = await evalExpr(e.right, env);
      switch (e.op) {
        case "+":  return l + r;
        case "-":  return l - r;
        case "*":  return l * r;
        case "/":  return l / r;
        case "==": return l === r ? 1 : 0;
        case "!=": return l !== r ? 1 : 0;
        case "<":  return l <  r ? 1 : 0;
        case ">":  return l >  r ? 1 : 0;
        case "<=": return l <= r ? 1 : 0;
        case ">=": return l >= r ? 1 : 0;
      }
      throw new Error("Unsupported op: " + e.op);
    }
    case "CallExpr": {
      const args = [];
      for (const a of e.args) args.push(await evalExpr(a, env));
      switch (e.name) {
        case "cos":   return Math.cos(args[0]);
        case "sin":   return Math.sin(args[0]);
        case "sqrt":  return Math.sqrt(args[0]);
        case "abs":   return Math.abs(args[0]);
        case "floor": return Math.floor(args[0]);
        case "rand":  return Math.floor(Math.random() * (Number(args[0]) || 1));
        case "randf": return Math.random() * (Number(args[0]) || 1);
        default:
          throw new Error("Unknown function in worker: " + e.name);
      }
    }
    default:
      throw new Error("Unsupported expr in worker: " + e.type);
  }
}
