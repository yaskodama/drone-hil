// Web Worker-based AIPL runtime: each actor runs in its own thread.
//
// Main thread holds the actor registry (name → Worker), routes inter-actor
// sends, and services builtins that need DOM access (canvas drawing, etc).
// Workers run actor method bodies with their own private state, using setTimeout
// for `wait(ms)` (real concurrent timing across actors).

const ACTOR_COLORS = ["#ff6060", "#60ff60", "#6090ff", "#ffcc00", "#ff60ff", "#60ffff"];

export class WorkerRuntime {
  constructor(printer = console.log) {
    this.print = printer;
    this.classes = new Map();
    this.actors  = new Map();   // name → Worker
    this.canvas  = null;
    this.scene   = new Map();   // actorName → {x1,y1,x2,y2,color}
    this._colorIdx = 0;
    this._actorColors = new Map();
  }

  setCanvas(c) { this.canvas = c; }

  reset() {
    for (const w of this.actors.values()) {
      try { w.terminate(); } catch {}
    }
    this.actors.clear();
    this.classes.clear();
    this.scene.clear();
    this._colorIdx = 0;
    this._actorColors.clear();
    if (this.canvas) {
      const ctx = this.canvas.getContext("2d");
      ctx.fillStyle = "#0a0a1a";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  registerClass(cls) { this.classes.set(cls.name, cls); }

  createActor(name, className, initArgs = []) {
    const cls = this.classes.get(className);
    if (!cls) throw new Error("Class not found: " + className);

    const worker = new Worker(new URL("./worker_actor.mjs", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => this._handleWorkerMessage(name, ev.data);
    worker.onerror   = (ev) => this.print(`[ERROR ${name}] ${ev.message}`);

    worker.postMessage({
      kind: "init",
      name, className,
      methods: cls.methods,
      fields:  cls.fields || [],
      initArgs,
    });

    this.actors.set(name, worker);
    this.print(`[actor created] ${name} : ${className}  (Worker thread)`);
  }

  // ---- inter-actor message routing ----------------------------------
  deliver(targetName, method, args, senderName = null) {
    const target = this.actors.get(targetName);
    if (!target) {
      this.print(`[ERROR] actor not found: ${targetName}`);
      return;
    }
    target.postMessage({ kind: "deliver", method, args, senderName });
  }

  _handleWorkerMessage(actorName, msg) {
    switch (msg.kind) {
      case "send":
        this.deliver(msg.target, msg.method, msg.args, msg.from);
        break;
      case "log":
        this.print(msg.message);
        break;
      case "primCall":
        this._handlePrim(actorName, msg.name, msg.args);
        break;
      case "reply":
        // Reply slots for now/future are not yet plumbed through workers.
        this.print(`[REPLY ${actorName}] ${msg.value}`);
        break;
    }
  }

  _handlePrim(actorName, name, args) {
    switch (name) {
      case "canvas_line":
      case "sdl_line": {
        const [x1, y1, x2, y2] = args;
        if (!this._actorColors.has(actorName)) {
          this._actorColors.set(actorName, ACTOR_COLORS[this._colorIdx++ % ACTOR_COLORS.length]);
        }
        this.scene.set(actorName, { x1, y1, x2, y2, color: this._actorColors.get(actorName) });
        this._redrawCanvas();
        break;
      }
      case "canvas_clear":
      case "sdl_clear":
        this.scene.clear();
        this._redrawCanvas();
        break;
      case "canvas_present":
      case "sdl_present":
        // immediate-mode canvas — nothing to do
        break;
      case "print":
        this.print(args[0]);
        break;
      default:
        this.print(`[unhandled prim] ${actorName} -> ${name}(${args.join(", ")})`);
    }
  }

  _redrawCanvas() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    const W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 2;
    for (const [, seg] of this.scene) {
      ctx.strokeStyle = seg.color;
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();
    }
  }

  // ---- top-level program execution ---------------------------------
  // We support the subset needed for the threaded-actor demos: class
  // declarations, `var x = new C(args);`, and top-level `send name.m(args);`.
  // Anything more (e.g. global now/future/await) belongs to the main-thread
  // Runtime.
  runProgram(ast) {
    this.reset();
    for (const cls of ast.classes) this.registerClass(cls);

    const env = {};
    for (const st of ast.statements) {
      try { this._evalTopStmt(st, env); }
      catch (e) { this.print(`[ERROR top] ${e.message}`); }
    }
  }

  _evalTopStmt(st, env) {
    switch (st.type) {
      case "VarDecl":
        if (st.expr && st.expr.type === "NewExpr") {
          const args = (st.expr.args || []).map(a => this._evalLitExpr(a, env));
          this.createActor(st.name, st.expr.className, args);
          env[st.name] = st.name;
        } else {
          env[st.name] = this._evalLitExpr(st.expr, env);
        }
        break;
      case "Send": {
        const targetName = (st.target in env) ? env[st.target] : st.target;
        const args = (st.args || []).map(a => this._evalLitExpr(a, env));
        this.deliver(targetName, st.method, args, null);
        break;
      }
      case "Print":
        this.print(String(this._evalLitExpr(st.expr, env)));
        break;
      default:
        this.print(`[top-level] unsupported: ${st.type}`);
    }
  }

  // Simple literal expression evaluator for top-level constants.
  _evalLitExpr(e, env) {
    if (!e) return null;
    switch (e.type) {
      case "IntLit":    return e.value;
      case "FloatLit":  return e.value;
      case "StringLit": return e.value;
      case "Var":       return e.name in env ? env[e.name] : e.name;
      case "Binop": {
        const l = this._evalLitExpr(e.left, env);
        const r = this._evalLitExpr(e.right, env);
        switch (e.op) {
          case "+": return l + r;
          case "-": return l - r;
          case "*": return l * r;
          case "/": return l / r;
        }
        return 0;
      }
      default:
        return null;
    }
  }
}
