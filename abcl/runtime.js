// Actor color palette for canvas drawing
const ACTOR_COLORS = ["#ff6060", "#60ff60", "#6090ff", "#ffcc00", "#ff60ff", "#60ffff"];

export class Runtime {
  constructor(printer = console.log) {
    this.print = printer;
    this._deferredReplies = [];
    this.classes = new Map();
    this.actors = new Map();
    this.nextId = 1;
    this.replies = [];
    this.canvas = null;        // set externally for canvas output
    this.scene = new Map();    // actorName → {x1,y1,x2,y2,color}   (for rotating lines)
    this.philoStates = new Map(); // id → 0(think)/1(hungry)/2(eat) (for philosophers)
    this.forkStates  = new Map(); // id → 0(free)/1(taken)
    this.forkHolders = new Map(); // id → holding philosopher id (absent when free)
    this._colorIdx = 0;
    this._actorColors = new Map();
    // Drone simulator world state
    this.droneWorld = null;         // {W,H,commRange,viewRange,obstacles:[],safeZone,start}
    this.droneActorById = new Map();   // droneId → actorName
    this.dronePositions = new Map();   // droneId → {x,y}
    this.droneStates    = new Map();   // droneId → 0(flying)/1(arrived)/2(dead)
    this.droneKnowledge = new Map();   // droneId → Set of known obstacle ids

    // ---- Reply slots for now / future / await -----------------------
    // JS is single-threaded, so `now`/`await` need a synchronous "drain":
    // we keep processing actor mailboxes one message at a time until the
    // target slot is fulfilled by some actor's reply().
    this.replySlots = new Map();         // slotId → { fulfilled, value }
    this._nextSlotId = 1;

    // ---- Bounded buffer visualization state -------------------------
    this.bufState = null;                // null until `call buf_init(cap);`

    // ---- Spreadsheet visualization state (Round 3 Phase 4) ----------
    this.sheetState = null;              // null until `call sheet_init(r,c);`

    // ---- Slider-driven runtime variables ----------------------------
    // Read by AIPL programs via the prod_speed() / cons_speed()
    // builtins. The console UI binds sliders to these fields so timings
    // can be tuned live without re-running the program.
    this._prodSpeed = 120;
    this._consSpeed = 420;

    // ---- AIOS coordination + protocol traces ------------------------
    this._aiosServices = new Map();   // alias → actor name
    this._aiosEvents   = [];
    this._protoDefs    = new Map();   // name → ["a.m", ...]
    this._protoActive  = new Map();   // sid → {name, idx, ended}
    this._protoEvents  = [];
    this._protoSeq     = 0;
  }

  setCanvas(canvas) {
    this.canvas = canvas;
  }

  reset() {
    this.classes.clear();
    this.actors.clear();
    this.nextId = 1;
    this.replies = [];
    this.replySlots.clear();
    this._nextSlotId = 1;
    this.scene.clear();
    this.philoStates.clear();
    this.forkStates.clear();
    this.forkHolders.clear();
    this._colorIdx = 0;
    this._actorColors.clear();
    this.droneWorld = null;
    this.droneActorById.clear();
    this.dronePositions.clear();
    this.droneStates.clear();
    this.droneKnowledge.clear();
    this.bufState = null;
    this.sheetState = null;
    this._aiosServices.clear();
    this._aiosEvents.length = 0;
    this._protoDefs.clear();
    this._protoActive.clear();
    this._protoEvents.length = 0;
    this._protoSeq = 0;
    if (this.canvas) {
      const ctx = this.canvas.getContext("2d");
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  registerClass(cls) {
    this.classes.set(cls.name, cls);
  }

  createActor(name, className, initArgs = []) {
    const cls = this.classes.get(className);
    if (!cls) throw new Error("Class not found: " + className);

    // Evaluate class field defaults to initialise actor state.  Fields
    // are evaluated in declaration order so a later field can refer to
    // an earlier one (e.g. `var cells[rows][cols];`).
    const state = {};
    for (const field of (cls.fields || [])) {
      state[field.name] = this._evalFieldExpr(field.expr, state);
    }

    const actor = {
      name,
      className,
      methods: new Map(cls.methods.map(m => [m.name, m])),
      mailbox: [],
      state,
      processing: false,
      scheduled: false,
      __nextDelay: 0,
    };

    this.actors.set(name, actor);
    this.print(`[actor created] ${name} : ${className}`);

    // Queue init — deferred so all actors exist before any init runs
    if (actor.methods.has("init")) {
      actor.mailbox.push({ methodName: "init", args: initArgs, unsafe: false, senderName: null });
      // Auto-schedule when the actor is created mid-run (e.g. spawned from
      // another actor's method). Top-level creation is still batched via
      // scheduleAllActors() after the program body finishes.
      this.scheduleActor(actor);
    }

    return actor;
  }

  // Simple expression evaluator for class field default values (no env needed)
  _evalFieldExpr(expr, state = {}) {
    if (!expr) return null;
    if (expr.type === "IntLit")   return expr.value;
    if (expr.type === "FloatLit") return expr.value;
    if (expr.type === "StringLit") return expr.value;
    if (expr.type === "Var" && state && expr.name in state) return state[expr.name];
    if (expr.type === "Binop") {
      const l = this._evalFieldExpr(expr.left, state);
      const r = this._evalFieldExpr(expr.right, state);
      switch (expr.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
      }
    }
    // フィールドを `var src = new Source();` と書いた場合。
    // ここに NewExpr の枝が無く、最後の `return 0` に落ちていたため、
    // フィールドはアクターではなく数値 0 になり、
    // そこへ送ると "actor not found: 0" で黙って失敗していた。
    if (expr.type === "NewExpr") {
      const name = expr.className.toLowerCase() + this.nextId++;
      const initArgs = (expr.args || []).map(a => this._evalFieldExpr(a, state));
      this.createActor(name, expr.className, initArgs);
      return name;              // JS-I はアクターを名前で指す
    }
    if (expr.type === "ArraySized") {
      const dims = expr.dims.map(d => this._evalFieldExpr(d, state) | 0);
      const fill = expr.init === null
        ? 0
        : this._evalFieldExpr(expr.init, state);
      const build = (ds) => {
        if (ds.length === 0) return fill;
        const n = ds[0];
        const rest = ds.slice(1);
        const arr = new Array(n);
        for (let i = 0; i < n; i++) arr[i] = build(rest);
        return arr;
      };
      return build(dims);
    }
    return 0;
  }

  hasSelectableMethod(actor, methodName) {
    for (const method of actor.methods.values()) {
      if (!method.body || !method.body.statements) continue;
      for (const st of method.body.statements) {
        if (st.type === "Select") {
          for (const c of st.cases) {
            if (c.method === methodName) return true;
          }
        }
      }
    }
    return false;
  }

  knowsMessage(actor, methodName) {
    return actor.methods.has(methodName) || this.hasSelectableMethod(actor, methodName);
  }

  // Enqueue a message — never dispatches synchronously (actor threads handle it).
  // slotId (optional) lets `now`/`future` correlate the reply back to a caller.
  send(actorName, methodName, args, unsafe = false, senderName = null, slotId = null) {
    const actor = this.actors.get(actorName);
    if (!actor) {
      if (unsafe) return;
      throw new Error("actor not found: " + actorName);
    }
    if (!unsafe && !this.knowsMessage(actor, methodName)) {
      throw new Error(`unknown method: ${actor.className}.${methodName}`);
    }
    actor.mailbox.push({ methodName, args, unsafe, senderName, slotId });
    this.print(`[send] ${actorName}.${methodName}(${args.join(", ")})`);
    // Only schedule if not currently inside this actor's invoke
    if (!actor.processing) this.scheduleActor(actor);
  }

  // ---- Reply slot helpers (for now / future / await) ----------------
  newReplySlot() {
    const id = "rs-" + (this._nextSlotId++);
    this.replySlots.set(id, { fulfilled: false, value: null });
    return id;
  }

  // wait で据え置かれた返信のうち、実時刻が来たものを解決する。
  // 戻り値は「まだ待っている返信が残っているか」。drain 側は
  // 仕事が無くてもこれが true の間は回り続ける必要がある。
  _flushDeferredReplies() {
    if (!this._deferredReplies || this._deferredReplies.length === 0) return false;
    const now = Date.now();
    const rest = [];
    for (const d of this._deferredReplies) {
      if (d.notBefore <= now) this.fulfillReplySlot(d.slotId, d.value);
      else rest.push(d);
    }
    this._deferredReplies = rest;
    return rest.length > 0;
  }

  fulfillReplySlot(slotId, value) {
    const slot = this.replySlots.get(slotId);
    if (slot && !slot.fulfilled) {
      slot.fulfilled = true;
      slot.value = value;
    }
  }

  // Find any actor with a dispatchable message and process exactly one of
  // them, synchronously (bypassing setTimeout). Returns true if a message
  // was processed, false if nothing was dispatchable.
  _drainOneStep() {
    const stillWaiting = this._flushDeferredReplies();
    for (const [, actor] of this.actors) {
      if (actor.processing) continue;
      const idx = actor.mailbox.findIndex(m => actor.methods.has(m.methodName));
      if (idx < 0) continue;
      const msg = actor.mailbox.splice(idx, 1)[0];
      actor.processing = true;
      actor.__currentSlotId = msg.slotId || null;
      try {
        this.invoke(actor, msg.methodName, msg.args, msg.unsafe, msg.senderName);
      } catch (e) {
        this.print(`[ERROR in ${actor.name}.${msg.methodName}] ${e.message}`);
      }
      actor.__currentSlotId = null;
      actor.processing = false;
      return true;
    }
    // 仕事は無いが、据え置かれた返信の時刻待ちが残っているなら
    // まだ進む余地がある（ここで false を返すと deadlock 扱いになる）。
    return stillWaiting;
  }

  // Drain actor mailboxes until the given slot is fulfilled. Throws if no
  // progress can be made and the slot is still pending.
  drainUntilSlot(slotId) {
    while (!this.replySlots.get(slotId).fulfilled) {
      if (!this._drainOneStep()) {
        throw new Error(`await/now deadlock: slot ${slotId} not fulfilled`);
      }
    }
    return this.replySlots.get(slotId).value;
  }

  // 期限つきの待ち。OCaml 版の `timeout <ms> else <expr>` 用。
  // 戻り値は { ok, value }。ok=false なら時間切れ（呼び出し側が else 節を評価する）。
  // 進める仕事が尽きた場合も、無期限版と違って例外にせず時間切れ扱いにする
  // ---- 期限を書いた側は「返らないこと」を織り込んでいるため。
  drainUntilSlotTimed(slotId, maxMs) {
    const start = Date.now();
    while (!this.replySlots.get(slotId).fulfilled) {
      if (Date.now() - start >= maxMs) return { ok: false, value: null };
      if (!this._drainOneStep()) return { ok: false, value: null };
    }
    return { ok: true, value: this.replySlots.get(slotId).value };
  }

  _toStr(v) {
    if (v === true) return "true";
    if (v === false) return "false";
    if (v === null || v === undefined) return "";
    return String(v);
  }

  // Schedule an actor to process its next dispatchable message
  scheduleActor(actor, delayMs = 0) {
    if (actor.processing || actor.scheduled) return;
    actor.scheduled = true;
    setTimeout(() => {
      actor.scheduled = false;
      this._processNextFor(actor);
    }, delayMs);
  }

  _processNextFor(actor) {
    const idx = actor.mailbox.findIndex(msg => actor.methods.has(msg.methodName));
    if (idx < 0) return;

    const msg = actor.mailbox.splice(idx, 1)[0];
    actor.processing = true;
    try {
      this.invoke(actor, msg.methodName, msg.args, msg.unsafe, msg.senderName);
    } catch (e) {
      this.print(`[ERROR in ${actor.name}.${msg.methodName}] ${e.message}`);
    }
    actor.processing = false;

    const delay = actor.__nextDelay || 0;
    actor.__nextDelay = 0;
    if (actor.mailbox.some(m => actor.methods.has(m.methodName))) {
      this.scheduleActor(actor, delay);
    }
  }

  // Kick off all actors that have pending messages (called after top-level stmts)
  scheduleAllActors() {
    for (const [, actor] of this.actors) {
      if (actor.mailbox.some(m => actor.methods.has(m.methodName))) {
        this.scheduleActor(actor, 0);
      }
    }
  }

  invoke(actor, methodName, args, unsafe = false, senderName = null) {
    const method = actor.methods.get(methodName);
    if (!method) {
      if (unsafe) { this.print(`[unsafe-send ignored] ${actor.className}.${methodName}`); return null; }
      throw new Error(`unknown method at runtime: ${actor.className}.${methodName}`);
    }

    // Env starts with actor instance state (instance variables)
    const env = {
      __currentActor: actor.name,
      sender: senderName,
      ...actor.state,
    };
    method.params.forEach((p, i) => { env[p] = args[i]; });

    let last = null;
    for (const st of method.body.statements) {
      last = this.evalStmt(st, env);
    }

    // Sync mutated instance variables back to actor state
    for (const key of Object.keys(actor.state)) {
      if (key in env) actor.state[key] = env[key];
    }
    return last;
  }

  evalStmt(stmt, env) {
    switch (stmt.type) {
      case "Print": {
        const v = this.evalExpr(stmt.expr, env);
        this.print(v);
        return v;
      }

      case "Reply": {
        const v = this.evalExpr(stmt.expr, env);
        this.replies.push(v);
        // If the current actor was invoked via now/future, fulfill the slot
        // so the awaiting caller can unblock.
        const actorName = env.__currentActor;
        if (actorName) {
          const actor = this.actors.get(actorName);
          if (actor && actor.__currentSlotId) {
            const delay = actor.__replyDelayMs || 0;
            if (delay > 0) {
              actor.__replyDelayMs = 0;
              this._deferredReplies.push({
                slotId: actor.__currentSlotId, value: v,
                notBefore: Date.now() + delay,
              });
            } else {
              this.fulfillReplySlot(actor.__currentSlotId, v);
            }
          }
        }
        this.print(`[REPLY] value=${v}`);
        return v;
      }

      case "VarDecl": {
        if (stmt.expr.type === "NewExpr") {
          const actorName = stmt.name;
          const className = stmt.expr.className;
          const initArgs = (stmt.expr.args || []).map(a => this.evalExpr(a, env));
          this.createActor(actorName, className, initArgs);
          env[stmt.name] = actorName;
          return actorName;
        }
        const v = this.evalExpr(stmt.expr, env);
        env[stmt.name] = v;
        return v;
      }

      case "Assign": {
        const v = this.evalExpr(stmt.expr, env);
        env[stmt.name] = v;
        // Immediately propagate to actor state if it's an instance variable
        if (env.__currentActor) {
          const actor = this.actors.get(env.__currentActor);
          if (actor && stmt.name in actor.state) actor.state[stmt.name] = v;
        }
        return v;
      }

      case "IndexAssign": {
        // a[i][j]… = expr
        let target = env[stmt.name];
        if (!Array.isArray(target))
          throw new Error("IndexAssign on non-array: " + stmt.name);
        const lastIdx = stmt.dims.length - 1;
        for (let i = 0; i < lastIdx; i++) {
          const idx = this.evalExpr(stmt.dims[i], env) | 0;
          if (!Array.isArray(target[idx]))
            throw new Error("IndexAssign: intermediate slot is not an array");
          target = target[idx];
        }
        const finalIdx = this.evalExpr(stmt.dims[lastIdx], env) | 0;
        const v = this.evalExpr(stmt.expr, env);
        target[finalIdx] = v;
        return v;
      }

      case "Send": {
        const senderName = env.__currentActor || null;
        const actorName = this.evalTarget(stmt.target, env);
        const args = stmt.args.map(a => this.evalExpr(a, env));
        this.send(actorName, stmt.method, args, stmt.unsafe, senderName);
        return null;
      }

      case "CallStmt": {
        const args = stmt.args.map(a => this.evalExpr(a, env));
        this._callBuiltin(stmt.name, args, env);
        return null;
      }

      case "If": {
        const c = this.evalExpr(stmt.cond, env);
        if (c) {
          for (const st of stmt.thenBody.statements) this.evalStmt(st, env);
        } else if (stmt.elseBody) {
          for (const st of stmt.elseBody.statements) this.evalStmt(st, env);
        }
        return null;
      }

      case "While": {
        // while <cond> do { ... }
        // 暴走したときに黙って固まらないよう、回数の上限を置く。
        let guard = 0;
        while (this.evalExpr(stmt.cond, env)) {
          for (const st of stmt.body.statements) this.evalStmt(st, env);
          if (++guard > 1000000) {
            throw new Error("while loop exceeded 1,000,000 iterations");
          }
        }
        return null;
      }

      case "Become": {
        // 自分の振る舞いを別のクラスへ置き換える。
        // 状態（state）は残し、新しいクラスに無い欄はそのまま、
        // 新しいクラスにしかない欄だけ初期化する。
        const actor = this.actors.get(env.__currentActor);
        if (!actor) throw new Error("become outside an actor");
        const cls = this.classes.get(stmt.className);
        if (!cls) throw new Error("Class not found: " + stmt.className);
        actor.className = stmt.className;
        actor.methods = new Map(cls.methods.map(m => [m.name, m]));
        for (const field of (cls.fields || [])) {
          if (!(field.name in actor.state)) {
            actor.state[field.name] = this._evalFieldExpr(field.expr, actor.state);
          }
        }
        if (actor.methods.has("init")) {
          const args = (stmt.args || []).map(a => this.evalExpr(a, env));
          actor.mailbox.unshift({ methodName: "init", args,
                                  unsafe: false, senderName: null });
          this.scheduleActor(actor);
        }
        return null;
      }

      case "Select":
        return this.evalSelect(stmt, env);

      case "Saga":
        return this.evalSaga(stmt, env);

      default:
        throw new Error("Unsupported statement: " + stmt.type);
    }
  }

  // DR-11: saga orchestration.  Run each step's body in order; on
  // any failure run the LIFO `compensate` blocks for all already-
  // completed steps and re-raise.  Structured NDJSON events match
  // the OCaml/Py-I event names verbatim.
  evalSaga(stmt, env) {
    const completed = [];   // indices of steps whose body finished
    this._ng_log_event("saga_started", { steps: stmt.steps.length });
    try {
      for (let i = 0; i < stmt.steps.length; i++) {
        const step = stmt.steps[i];
        for (const st of step.body.statements) this.evalStmt(st, env);
        completed.push(i);
        this._ng_log_event("saga_step_complete", { index: i });
      }
      this._ng_log_event("saga_finished", { steps: stmt.steps.length });
      return null;
    } catch (err) {
      const idx = completed.length;   // index of the failing step
      this._ng_log_event("saga_step_failed", {
        index: idx, error: String(err.message || err),
      });
      for (let j = completed.length - 1; j >= 0; j--) {
        const step = stmt.steps[completed[j]];
        try {
          for (const st of step.compensate.statements) this.evalStmt(st, env);
          this._ng_log_event("saga_compensated", { index: completed[j] });
        } catch (cerr) {
          this._ng_log_event("saga_compensate_failed", {
            index: completed[j], error: String(cerr.message || cerr),
          });
        }
      }
      this._ng_log_event("saga_aborted", {
        failed_index: idx, compensated: completed.length,
      });
      throw err;
    }
  }

  _callBuiltin(name, args, env) {
    const actorName = env.__currentActor || null;
    const actor = actorName ? this.actors.get(actorName) : null;

    // AIOS / protocol builtins: shared dispatch (also reachable from CallExpr)
    const ap = this._dispatchAiosProtocol(name, args, env);
    if (ap.handled) return ap.value;

    switch (name) {
      // ---- result<τ> と資源（OCaml 版・Py-I と同じ組込み） ----
      case "is_ok": {
        const r = args[0];
        if (!r || r.__result !== true) throw new Error("is_ok(r): a result is expected");
        return r.ok;
      }
      case "timed_out": {
        const r = args[0];
        if (!r || r.__result !== true) throw new Error("timed_out(r): a result is expected");
        return !r.ok;
      }
      case "value": {
        const r = args[0];
        if (!r || r.__result !== true)
          throw new Error("value(r, default): a result and a default are expected");
        return r.ok ? r.value : args[1];
      }
      case "acquire": {
        if (!this._heldRes) this._heldRes = new Set();
        if (this._heldRes.has(args[0]))
          throw new Error("acquire: resource already held: " + args[0]);
        this._heldRes.add(args[0]);
        return null;
      }
      case "release": {
        if (!this._heldRes) this._heldRes = new Set();
        if (!this._heldRes.has(args[0]))
          throw new Error("release: resource not held: " + args[0]);
        this._heldRes.delete(args[0]);
        return null;
      }

      case "wait": {
        // Delay next message dispatch for this actor
        const ms = Number(args[0]) || 0;
        if (actor) {
          actor.__nextDelay = ms;
          // OCaml 版・Py-I の wait はメソッド実行中にブロックするので、
          // その後の reply も ms だけ遅れる。ブラウザでは同期ブロックできない
          // ため、代わりに「この先の reply を ms だけ遅らせる」形で近似する。
          // これをしないと `wait(300); reply(x);` が即返信し、
          // now ... timeout 100 else 0 の期限が発火しない（g7_deadline）。
          actor.__replyDelayMs = (actor.__replyDelayMs || 0) + ms;
        }
        break;
      }
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
        // No-op: redrawCanvas clears automatically before drawing
        break;
      case "canvas_present":
      case "sdl_present":
        // No-op for canvas (immediate mode)
        break;
      case "philo_state": {
        // args: (id, state)  state: 0=thinking, 1=hungry, 2=eating
        this.philoStates.set(Number(args[0]), Number(args[1]));
        this._redrawCanvas();
        break;
      }
      case "fork_state": {
        // args: (id, state)  state: 0=free, 1=taken  (legacy — no holder info)
        this.forkStates.set(Number(args[0]), Number(args[1]));
        if (Number(args[1]) === 0) this.forkHolders.delete(Number(args[0]));
        this._redrawCanvas();
        break;
      }
      case "fork_free": {
        // args: (id)  — fork becomes free
        const fid = Number(args[0]);
        this.forkStates.set(fid, 0);
        this.forkHolders.delete(fid);
        this._redrawCanvas();
        break;
      }
      case "fork_held": {
        // args: (id, holderId)  — fork is held by philosopher holderId
        const fid = Number(args[0]);
        const hid = Number(args[1]);
        this.forkStates.set(fid, 1);
        this.forkHolders.set(fid, hid);
        this._redrawCanvas();
        break;
      }
      case "print":
        this.print(args[0]);
        break;

      // ---------------- Spreadsheet visualization (Round 3 Phase 4) ----------
      // R3 LayerComposite: a single canvas with grid + content + selection
      // sub-layers drawn in order.  AIPL calls:
      //   sheet_init(rows, cols)           — reset grid metrics
      //   sheet_cell(row, col, val, kind)  — push one cell payload
      //   sheet_select(row, col)           — highlight a cell (or -1,-1)
      // After every call, _redrawCanvas re-paints all 3 layers.
      case "sheet_init": {
        this.sheetState = {
          rows: Number(args[0]) || 3,
          cols: Number(args[1]) || 3,
          cells: [],
          sel: { row: -1, col: -1 },
        };
        this._redrawCanvas();
        break;
      }
      case "sheet_cell": {
        if (!this.sheetState) break;
        const row  = Number(args[0]);
        const col  = Number(args[1]);
        const cell = {
          row, col,
          val:  String(args[2]),
          kind: String(args[3] || "Value"),
        };
        // Phase 5.5 fix: REPLACE the existing (row, col) entry instead
        // of pushing a duplicate.  Previously every commit grew the
        // cells array; the renderer drew the old + new on top of each
        // other, leaving fragments of the older value visible.
        const cells = this.sheetState.cells;
        const idx = cells.findIndex(c => c.row === row && c.col === col);
        if (idx >= 0) cells[idx] = cell;
        else          cells.push(cell);
        this._redrawCanvas();
        break;
      }
      case "sheet_select": {
        if (!this.sheetState) break;
        this.sheetState.sel = {
          row: Number(args[0]),
          col: Number(args[1]),
        };
        this.sheetState.selRange = null;   // U5: clear any range highlight.
        this._redrawCanvas();
        break;
      }
      // C6: live peer cursors — origin → {row, col, color}.  Cleared
      // by passing color = "" (peer disconnected from this view).
      case "sheet_peer_cursor": {
        if (!this.sheetState) break;
        const origin = String(args[0] || "");
        const row    = Number(args[1]);
        const col    = Number(args[2]);
        const color  = args[3] == null ? "" : String(args[3]);
        if (!this.sheetState.peerCursors) this.sheetState.peerCursors = new Map();
        if (!color) this.sheetState.peerCursors.delete(origin);
        else        this.sheetState.peerCursors.set(origin, { row, col, color });
        this._redrawCanvas();
        break;
      }
      // F9: corner indicator for cells carrying a comment.  hasNote
      // is 1/true to set, 0/false (or empty) to clear.
      case "sheet_cell_note": {
        if (!this.sheetState) break;
        const row = Number(args[0]), col = Number(args[1]);
        const has = !!args[2];
        if (!this.sheetState.cellNotes) this.sheetState.cellNotes = new Set();
        const key = row + "," + col;
        if (has) this.sheetState.cellNotes.add(key);
        else     this.sheetState.cellNotes.delete(key);
        this._redrawCanvas();
        break;
      }
      // F8: per-cell background fill for conditional formatting.
      // color = "" or null clears.
      case "sheet_cell_bg": {
        if (!this.sheetState) break;
        const row = Number(args[0]), col = Number(args[1]);
        const color = (args[2] == null || args[2] === "") ? null : String(args[2]);
        if (!this.sheetState.cellBgs) this.sheetState.cellBgs = new Map();
        const key = row + "," + col;
        if (color) this.sheetState.cellBgs.set(key, color);
        else       this.sheetState.cellBgs.delete(key);
        this._redrawCanvas();
        break;
      }
      // U5: rectangular drag-selection highlight.  Coordinates may
      // arrive in any order (dragged up-left from down-right); we
      // normalize before storing.  r1=c1=-1 clears.
      case "sheet_select_range": {
        if (!this.sheetState) break;
        const r0 = Number(args[0]), c0 = Number(args[1]);
        const r1 = Number(args[2]), c1 = Number(args[3]);
        if (r1 < 0 || c1 < 0) {
          this.sheetState.selRange = null;
        } else {
          this.sheetState.selRange = {
            r0: Math.min(r0, r1), c0: Math.min(c0, c1),
            r1: Math.max(r0, r1), c1: Math.max(c0, c1),
          };
        }
        this._redrawCanvas();
        break;
      }

      // ---------------- Bounded buffer visualization -------------
      case "buf_init": {
        const cap = Number(args[0]) || 4;
        this.bufState = {
          cap,
          slots: new Array(cap).fill(null),
          pstate: "idle", cstate: "idle",
          pn: 0, cn: 0,
        };
        this._redrawCanvas();
        break;
      }
      case "buf_set": {
        if (!this.bufState) break;
        const idx = Number(args[0]);
        const val = args[1];
        if (idx >= 0 && idx < this.bufState.slots.length) {
          this.bufState.slots[idx] = val;
          this._redrawCanvas();
        }
        break;
      }
      case "buf_clear": {
        if (!this.bufState) break;
        const idx = Number(args[0]);
        if (idx >= 0 && idx < this.bufState.slots.length) {
          this.bufState.slots[idx] = null;
          this._redrawCanvas();
        }
        break;
      }
      case "buf_pstate": {
        if (!this.bufState) break;
        this.bufState.pstate = String(args[0]);
        this._redrawCanvas();
        break;
      }
      case "buf_cstate": {
        if (!this.bufState) break;
        this.bufState.cstate = String(args[0]);
        this._redrawCanvas();
        break;
      }
      case "buf_pn": {
        if (!this.bufState) break;
        this.bufState.pn = Number(args[0]) || 0;
        this._redrawCanvas();
        break;
      }
      case "buf_cn": {
        if (!this.bufState) break;
        this.bufState.cn = Number(args[0]) || 0;
        this._redrawCanvas();
        break;
      }

      // ---------------- Drone simulator built-ins ----------------
      case "world_setup": {
        const [W, H, commR, viewR] = args;
        this.droneWorld = {
          W: Number(W) || 800,
          H: Number(H) || 600,
          commRange: Number(commR) || 100,
          viewRange: Number(viewR) || 50,
          obstacles: [],
          safeZone: null,
          stats: { arrived: 0, dead: 0, total: 0 },
        };
        if (this.canvas) {
          this.canvas.width  = this.droneWorld.W;
          this.canvas.height = this.droneWorld.H;
        }
        this._redrawCanvas();
        break;
      }
      case "place_obstacle": {
        if (!this.droneWorld) break;
        const [oid, ox, oy, orad] = args;
        this.droneWorld.obstacles.push({
          id: Number(oid), x: Number(ox), y: Number(oy), r: Number(orad),
        });
        this._redrawCanvas();
        break;
      }
      case "place_safe": {
        if (!this.droneWorld) break;
        const [sx, sy, sr] = args;
        this.droneWorld.safeZone = { x: Number(sx), y: Number(sy), r: Number(sr) };
        this._redrawCanvas();
        break;
      }
      case "drone_register": {
        const did = Number(args[0]);
        if (actorName) this.droneActorById.set(did, actorName);
        this.droneKnowledge.set(did, new Set());
        if (this.droneWorld) this.droneWorld.stats.total++;
        break;
      }
      case "drone_pos": {
        const [did, px, py] = args;
        this.dronePositions.set(Number(did), { x: Number(px), y: Number(py) });
        this._redrawCanvas();
        break;
      }
      case "drone_state": {
        const [did, st] = args;
        const prev = this.droneStates.get(Number(did));
        this.droneStates.set(Number(did), Number(st));
        if (this.droneWorld) {
          if (prev !== 1 && Number(st) === 1) this.droneWorld.stats.arrived++;
          if (prev !== 2 && Number(st) === 2) this.droneWorld.stats.dead++;
        }
        this._redrawCanvas();
        break;
      }
      case "drone_scan": {
        if (!this.droneWorld) break;
        const [did, px, py] = args;
        const vR = this.droneWorld.viewRange;
        const dronePos = { x: Number(px), y: Number(py) };
        const known = this.droneKnowledge.get(Number(did)) || new Set();
        for (const ob of this.droneWorld.obstacles) {
          if (known.has(ob.id)) continue;
          const d = Math.hypot(ob.x - dronePos.x, ob.y - dronePos.y) - ob.r;
          if (d <= vR) {
            const aName = this.droneActorById.get(Number(did));
            if (aName) this.send(aName, "learn_obstacle", [ob.id, ob.x, ob.y, ob.r], true, null);
          }
        }
        break;
      }
      case "drone_broadcast": {
        if (!this.droneWorld) break;
        const [srcId, obsId, ox, oy, orad] = args;
        const srcPos = this.dronePositions.get(Number(srcId));
        if (!srcPos) break;
        const cR = this.droneWorld.commRange;
        for (const [otherId, pos] of this.dronePositions) {
          if (otherId === Number(srcId)) continue;
          const d = Math.hypot(pos.x - srcPos.x, pos.y - srcPos.y);
          if (d > cR) continue;
          const known = this.droneKnowledge.get(otherId);
          if (known && known.has(Number(obsId))) continue;
          const aName = this.droneActorById.get(otherId);
          if (aName) this.send(aName, "learn_obstacle", [Number(obsId), ox, oy, orad], true, null);
        }
        break;
      }
      case "drone_remember": {
        const [did, obsId] = args;
        const k = this.droneKnowledge.get(Number(did));
        if (k) k.add(Number(obsId));
        break;
      }

      /* ---- text file I/O (Node host only) ---- */
      case "read_file":   this._fsRead(args[0]); break;
      case "write_file":  this._fsWrite(args[0], args[1], false); break;
      case "append_file": this._fsWrite(args[0], args[1], true); break;
      case "file_exists": /* discarded as a statement */ break;

      /* ---- image I/O ---- */
      case "image_save":      this._imageSave(args[0], args[1]); break;
      case "image_set_pixel": this._imageSetPixel(args); break;
      /* image_create / image_load / image_size / image_pixel are
         expression-only — using them as stmts has no observable
         effect, so we just discard. */
      case "image_create":
      case "image_load":
      case "image_size":
      case "image_pixel":     break;

      default: {
        // Next-gen primitives (CE-11 + DR-10/11/12/13): route via the
        // shared dispatcher so CallStmt parity matches CallExpr.
        if (this._dispatchNextgen(name, args)) break;
        this.print(`[call] ${name}(${args.join(", ")})`);
      }
    }
  }

  // Routing helper: returns true when the name was a next-gen primitive
  // and was handled.  Used by both _callBuiltin (statement form) and as
  // a fallthrough for the CallExpr switch's "Unknown function" case.
  _dispatchNextgen(name, args) {
    switch (name) {
      case "grant_cap":              this._nextgen_grant_cap(args);              return true;
      case "revoke_cap":             this._nextgen_revoke_cap(args);             return true;
      case "has_cap":                this._nextgen_has_cap(args);                return true;
      case "current_caps":           this._nextgen_current_caps();               return true;
      case "check_capability":       this._nextgen_check_capability(args);       return true;
      case "current_region":         this._nextgen_current_region();             return true;
      case "region_chain":           this._nextgen_region_chain();               return true;
      case "route_for_region":       this._nextgen_route_for_region(args);       return true;
      case "failover_region":        this._nextgen_failover_region(args);        return true;
      case "regions_available":      this._nextgen_regions_available();          return true;
      case "pool_create":            this._nextgen_pool_create(args);            return true;
      case "pool_pick":              this._nextgen_pool_pick(args);              return true;
      case "pool_size":              this._nextgen_pool_size(args);              return true;
      case "pool_destroy":           this._nextgen_pool_destroy(args);           return true;
      case "crdt_gcounter_new":      this._nextgen_crdt_gcounter_new();          return true;
      case "crdt_gcounter_inc":      this._nextgen_crdt_gcounter_inc(args);      return true;
      case "crdt_gcounter_value":    this._nextgen_crdt_gcounter_value(args);    return true;
      case "crdt_gcounter_merge":    this._nextgen_crdt_gcounter_merge(args);    return true;
      case "crdt_orset_new":         this._nextgen_crdt_orset_new();             return true;
      case "crdt_orset_add":         this._nextgen_crdt_orset_add(args);         return true;
      case "crdt_orset_remove":      this._nextgen_crdt_orset_remove(args);      return true;
      case "crdt_orset_contains":    this._nextgen_crdt_orset_contains(args);    return true;
      case "crdt_orset_values":      this._nextgen_crdt_orset_values(args);      return true;
      case "crdt_orset_merge":       this._nextgen_crdt_orset_merge(args);       return true;
      case "crdt_lww_new":           this._nextgen_crdt_lww_new(args);           return true;
      case "crdt_lww_write":         this._nextgen_crdt_lww_write(args);         return true;
      case "crdt_lww_value":         this._nextgen_crdt_lww_value(args);         return true;
      case "crdt_lww_merge":         this._nextgen_crdt_lww_merge(args);         return true;
      case "crdt_replicate":         this._nextgen_crdt_replicate(args);         return true;
      default:                                                                    return false;
    }
  }

  _redrawCanvas() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    const W = this.canvas.width, H = this.canvas.height;

    // Clear background (wireframe dark blue)
    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, W, H);

    // Rotating line segments (Rotate4Lines etc.)
    ctx.lineWidth = 2;
    for (const [, seg] of this.scene) {
      ctx.strokeStyle = seg.color;
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();
    }

    // Dining Philosophers wireframe
    if (this.philoStates.size > 0 || this.forkStates.size > 0) {
      this._drawPhilosophers(ctx, W, H);
    }

    // Drone return-route simulator
    if (this.droneWorld) {
      this._drawDroneWorld(ctx, W, H);
    }

    // Bounded buffer
    if (this.bufState) {
      this._drawBufferState(ctx, W, H);
    }

    // Spreadsheet (Round 3 Phase 4 — R3 LayerComposite)
    if (this.sheetState) {
      this._drawSheetState(ctx, W, H);
    }
  }

  _drawSheetState(ctx, W, H) {
    const s    = this.sheetState;
    const cw   = Math.floor((W - 60) / (s.cols + 1));   // +1 for row-header column
    const ch   = s.cellH || 32;     // U9: row height from sheetState
    const x0   = 30;
    const y0   = 30;
    const totW = cw * (s.cols + 1);
    const totH = ch * (s.rows + 1);

    // Background panel
    ctx.fillStyle = "#fdfdfd";
    ctx.fillRect(x0 - 6, y0 - 6, totW + 12, totH + 12);

    // F8: conditional-format backgrounds — drawn FIRST so the
    // selection tints can sit on top of them.
    if (s.cellBgs) {
      for (const [key, color] of s.cellBgs) {
        const [r, c] = key.split(",").map(Number);
        if (r >= 0 && r < s.rows && c >= 0 && c < s.cols) {
          ctx.fillStyle = color;
          ctx.fillRect(
            x0 + (c + 1) * cw,
            y0 + (r + 1) * ch,
            cw, ch
          );
        }
      }
    }
    // ── Layer 1: selection highlight (drawn first so it sits under
    //              grid lines and text). ───────────────────────
    // U5: a drag-range, if present, paints a softer fill across the
    // whole rectangle; a single-cell sel still gets the brighter
    // tint on top so the anchor cell stays visually distinct.
    if (s.selRange) {
      const r = s.selRange;
      ctx.fillStyle = "#e8f3ff";
      ctx.fillRect(
        x0 + (r.c0 + 1) * cw,
        y0 + (r.r0 + 1) * ch,
        (r.c1 - r.c0 + 1) * cw,
        (r.r1 - r.r0 + 1) * ch,
      );
    }
    if (s.sel.row >= 0 && s.sel.col >= 0) {
      // C6-followup: paint the local selection with the user's own
      // peer-color (pastel), so the "color-inverted" cell always
      // tracks the live cursor.  Fall back to the original light
      // blue if no selColor has been stashed yet.
      const sx = x0 + (s.sel.col + 1) * cw;
      const sy = y0 + (s.sel.row + 1) * ch;
      if (s.selColor) {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = s.selColor;
        ctx.fillRect(sx, sy, cw, ch);
        ctx.restore();
        ctx.lineWidth   = 2;
        ctx.strokeStyle = s.selColor;
        ctx.strokeRect(sx + 1, sy + 1, cw - 2, ch - 2);
      } else {
        ctx.fillStyle = "#d1e9ff";
        ctx.fillRect(sx, sy, cw, ch);
      }
    }

    // ── Layer 2: grid lines (the "wireframe"). ───────────────
    ctx.strokeStyle = "#bbbbbb";
    ctx.lineWidth   = 1;
    for (let c = 0; c <= s.cols + 1; c++) {
      ctx.beginPath();
      ctx.moveTo(x0 + c * cw, y0);
      ctx.lineTo(x0 + c * cw, y0 + totH);
      ctx.stroke();
    }
    for (let r = 0; r <= s.rows + 1; r++) {
      ctx.beginPath();
      ctx.moveTo(x0,        y0 + r * ch);
      ctx.lineTo(x0 + totW, y0 + r * ch);
      ctx.stroke();
    }

    // Header row + column shading
    ctx.fillStyle = "#eef0f4";
    ctx.fillRect(x0, y0, totW, ch);                          // top header
    ctx.fillRect(x0, y0, cw,   totH);                        // left header
    // re-stroke borders that were just over-painted
    ctx.strokeStyle = "#bbbbbb";
    for (let c = 0; c <= s.cols + 1; c++) {
      ctx.beginPath();
      ctx.moveTo(x0 + c * cw, y0);
      ctx.lineTo(x0 + c * cw, y0 + totH);
      ctx.stroke();
    }
    for (let r = 0; r <= s.rows + 1; r++) {
      ctx.beginPath();
      ctx.moveTo(x0,        y0 + r * ch);
      ctx.lineTo(x0 + totW, y0 + r * ch);
      ctx.stroke();
    }

    // ── Layer 3: text content (col labels A B C, row labels 1 2 3,
    //              and computed cell values). ─────────────────
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle    = "#444";
    ctx.font         = "bold 13px monospace";
    // G5: base-26 letter labels (A..Z, AA..AZ, BA..) for wide grids.
    const colLabel = (col) => {
      let s = "", n = col + 1;
      while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s || "A";
    };
    for (let c = 0; c < s.cols; c++) {
      ctx.fillText(colLabel(c),
        x0 + (c + 1) * cw + cw / 2, y0 + ch / 2);
    }
    for (let r = 0; r < s.rows; r++) {
      ctx.fillText(String(r + 1),
        x0 + cw / 2, y0 + (r + 1) * ch + ch / 2);
    }

    ctx.font = "13px monospace";
    for (const c of s.cells) {
      const px = x0 + (c.col + 1) * cw + cw / 2;
      const py = y0 + (c.row + 1) * ch + ch / 2;
      ctx.fillStyle = c.kind === "Formula" ? "#2255aa" : "#222";
      ctx.fillText(c.val, px, py);
    }
    // C6: paint live peer cursors with a soft tinted fill AND a
    // solid outline.  The 0.25-alpha fill produces a visible
    // "color inverted" feel without washing out the cell text; the
    // outline preserves the peer-color identity.
    if (s.peerCursors && s.peerCursors.size > 0) {
      for (const [origin, c] of s.peerCursors) {
        if (c.row < 0 || c.row >= s.rows || c.col < 0 || c.col >= s.cols) continue;
        const x = x0 + (c.col + 1) * cw + 1;
        const y = y0 + (c.row + 1) * ch + 1;
        // Soft fill (alpha 0.25) on top of any existing bg / selection.
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = c.color;
        ctx.fillRect(x, y, cw - 2, ch - 2);
        ctx.restore();
        // Solid outline.
        ctx.lineWidth   = 2;
        ctx.strokeStyle = c.color;
        ctx.strokeRect(x, y, cw - 2, ch - 2);
        // Origin label above the cell.
        ctx.fillStyle = c.color;
        ctx.font = "10px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillText(origin.slice(0, 8), x + 1, y - 2);
        ctx.textBaseline = "middle";
        ctx.font = "13px monospace";
      }
    }
    // F9: paint a tiny red corner triangle on cells with comments.
    if (s.cellNotes && s.cellNotes.size > 0) {
      ctx.fillStyle = "#c33";
      for (const key of s.cellNotes) {
        const [r, col] = key.split(",").map(Number);
        if (r < 0 || r >= s.rows || col < 0 || col >= s.cols) continue;
        const x = x0 + (col + 2) * cw - 8;
        const y = y0 + (r   + 1) * ch + 1;
        ctx.beginPath();
        ctx.moveTo(x,     y);
        ctx.lineTo(x + 8, y);
        ctx.lineTo(x + 8, y + 8);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Footer caption
    ctx.fillStyle = "#666";
    ctx.font      = "11px monospace";
    ctx.textAlign = "left";
    ctx.fillText(
      "Round 3 Phase 4 — R3 LayerComposite (selection / grid / text)",
      x0, y0 + totH + 18
    );
  }

  _drawBufferState(ctx, W, H) {
    const s = this.bufState;
    const cap = s.cap;

    // Layout: producer box (left) — buffer slots (middle) — consumer box (right)
    const PROD_X = 60;
    const CONS_X = W - 60;
    const ROW_Y  = Math.floor(H / 2);

    const slotW = Math.max(18, Math.min(40, Math.floor((W - 240) / cap) - 2));
    const slotH = 36;
    const gap   = 2;
    const totalW = cap * slotW + (cap - 1) * gap;
    const bufLeft = Math.floor(W / 2 - totalW / 2);
    const slotCx = (i) => bufLeft + i * (slotW + gap) + slotW / 2;

    // Background row
    ctx.fillStyle = "#10101e";
    ctx.fillRect(bufLeft - 10, ROW_Y - slotH/2 - 6, totalW + 20, slotH + 12);

    // Producer box
    {
      const blocked = s.pstate === "blocked";
      ctx.fillStyle   = blocked ? "#3a2410" : "#142848";
      ctx.strokeStyle = blocked ? "#ff9955" : "#66ccff";
      ctx.lineWidth = 2;
      ctx.fillRect(PROD_X - 40, ROW_Y - 28, 80, 56);
      ctx.strokeRect(PROD_X - 40, ROW_Y - 28, 80, 56);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 12px monospace";
      ctx.textAlign = "center";
      ctx.fillText("Producer", PROD_X, ROW_Y - 8);
      ctx.fillStyle = blocked ? "#ff9955" : "#aef";
      ctx.font = "10px monospace";
      ctx.fillText(blocked ? "BLOCKED" : (s.pstate || "idle"), PROD_X, ROW_Y + 8);
      ctx.fillStyle = "#88c0ff";
      ctx.fillText("sent=" + s.pn, PROD_X, ROW_Y + 22);
    }

    // Consumer box
    {
      const blocked = s.cstate === "blocked";
      ctx.fillStyle   = blocked ? "#3a2410" : "#3a2a14";
      ctx.strokeStyle = blocked ? "#ff9955" : "#ffcc66";
      ctx.lineWidth = 2;
      ctx.fillRect(CONS_X - 40, ROW_Y - 28, 80, 56);
      ctx.strokeRect(CONS_X - 40, ROW_Y - 28, 80, 56);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 12px monospace";
      ctx.textAlign = "center";
      ctx.fillText("Consumer", CONS_X, ROW_Y - 8);
      ctx.fillStyle = blocked ? "#ff9955" : "#fe9";
      ctx.font = "10px monospace";
      ctx.fillText(blocked ? "BLOCKED" : (s.cstate || "idle"), CONS_X, ROW_Y + 8);
      ctx.fillStyle = "#ffd088";
      ctx.fillText("taken=" + s.cn, CONS_X, ROW_Y + 22);
    }

    // Arrows from producer to buffer & buffer to consumer
    ctx.strokeStyle = "#445";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PROD_X + 40, ROW_Y);
    ctx.lineTo(bufLeft - 4, ROW_Y);
    ctx.moveTo(bufLeft + totalW + 4, ROW_Y);
    ctx.lineTo(CONS_X - 40, ROW_Y);
    ctx.stroke();

    // Buffer slots
    let filled = 0;
    for (let i = 0; i < cap; i++) {
      const x = bufLeft + i * (slotW + gap);
      const y = ROW_Y - slotH / 2;
      const v = s.slots[i];
      const has = v !== null && v !== undefined;
      if (has) filled++;
      ctx.fillStyle   = has ? "#123a20" : "#101022";
      ctx.fillRect(x, y, slotW, slotH);
      ctx.strokeStyle = has ? "#55ff55" : "#445";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, slotW, slotH);
      if (has) {
        ctx.fillStyle = "#afe";
        ctx.textAlign = "center";
        const lbl = String(v);
        ctx.font = lbl.length <= 2 ? "bold 13px monospace"
                 : lbl.length <= 3 ? "bold 10px monospace"
                 :                   "bold 8px monospace";
        ctx.fillText(lbl, x + slotW/2, ROW_Y + 5);
      }
      // index labels every few slots
      if (cap <= 8 || i % 5 === 0 || i === cap - 1) {
        ctx.fillStyle = "#667";
        ctx.font = "9px monospace";
        ctx.fillText("s" + i, x + slotW/2, y + slotH + 10);
      }
    }

    // count display
    ctx.fillStyle = "#778";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText(`count = ${filled} / ${cap}`,
                 bufLeft + totalW / 2, ROW_Y - slotH/2 - 14);
  }

  _drawDroneWorld(ctx, W, H) {
    const world = this.droneWorld;

    // Safe zone (destination) — green region
    if (world.safeZone) {
      const sz = world.safeZone;
      ctx.fillStyle   = "rgba(60, 220, 120, 0.25)";
      ctx.strokeStyle = "#3ddc78";
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.arc(sz.x, sz.y, sz.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#3ddc78";
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText("SAFE", sz.x, sz.y + 4);
    }

    // Obstacles (impassable disaster zones) — purple
    for (const ob of world.obstacles) {
      ctx.fillStyle   = "rgba(160, 60, 200, 0.28)";
      ctx.strokeStyle = "#c060e0";
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.arc(ob.x, ob.y, ob.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#d890f0";
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText("X" + ob.id, ob.x, ob.y + 4);
    }

    // MANET links — thin lines between drones within comm range
    const positions = Array.from(this.dronePositions.entries());
    const cR = world.commRange;
    ctx.strokeStyle = "rgba(120, 160, 255, 0.28)";
    ctx.lineWidth   = 1;
    for (let i = 0; i < positions.length; i++) {
      const [idA, pa] = positions[i];
      const sA = this.droneStates.get(idA) || 0;
      if (sA === 2) continue;
      for (let j = i + 1; j < positions.length; j++) {
        const [idB, pb] = positions[j];
        const sB = this.droneStates.get(idB) || 0;
        if (sB === 2) continue;
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        if (d <= cR) {
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      }
    }

    // Drones — red dots (arrived=green, dead=gray); informed drones get a yellow halo
    for (const [id, pos] of this.dronePositions) {
      const st    = this.droneStates.get(id) || 0;
      const known = this.droneKnowledge.get(id);
      if (known && known.size > 0 && st !== 2) {
        ctx.strokeStyle = "rgba(255, 220, 80, 0.7)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      let fill = "#ff4a5c";
      if (st === 1) fill = "#3ddc78";
      else if (st === 2) fill = "#666";
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Stats HUD
    const s = world.stats;
    ctx.fillStyle = "#aac";
    ctx.font = "12px monospace";
    ctx.textAlign = "left";
    ctx.fillText(`drones:${s.total}  arrived:${s.arrived}  dead:${s.dead}`, 8, 16);
    ctx.fillText(`comm=${world.commRange}  view=${world.viewRange}`, 8, 32);
  }

  _drawPhilosophers(ctx, W, H) {
    const N = 5;
    const cx = W / 2, cy = H / 2;
    const R  = Math.min(W, H) * 0.32;       // philosopher ring radius

    const PHILO_COLORS = ["#ff5566", "#ffa833", "#3ddc6e", "#3aa8ff", "#c765ff"];
    const STATE_NAME   = ["THINK", "HUNGRY", "EAT"];
    const STATE_INNER  = ["#334",  "#ffcc40", "#40e070"];

    // Pentagon vertices — philosopher positions
    const philoPos = [];
    for (let i = 0; i < N; i++) {
      const theta = -Math.PI / 2 + (i * 2 * Math.PI / N);
      philoPos.push({
        x: cx + R * Math.cos(theta),
        y: cy + R * Math.sin(theta),
        theta,
      });
    }

    // Fork rest positions — midpoints of pentagon EDGES. This places each
    // fork geometrically between the two philosophers who share it (exactly
    // where you'd expect a fork on a round table). Fork i is between phil i
    // and phil (i+1)%N.
    const forkPos = [];
    for (let i = 0; i < N; i++) {
      const a = philoPos[i], b = philoPos[(i + 1) % N];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // Tangent direction (along the edge) — used for the FREE orientation.
      const ex = b.x - a.x, ey = b.y - a.y;
      const elen = Math.hypot(ex, ey) || 1;
      forkPos.push({
        x: mx, y: my,
        tx: ex / elen, ty: ey / elen,        // unit tangent along the edge
      });
    }

    // Table outline — pentagon edges in a dim hue
    ctx.strokeStyle = "#262640";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const a = philoPos[i], b = philoPos[(i + 1) % N];
      if (i === 0) ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.closePath();
    ctx.stroke();

    // Forks ---------------------------------------------------------------
    //   FREE : short gray line at the edge-midpoint, oriented ALONG the edge
    //   HELD : fork translates 50 % toward the holder, adopts the holder's
    //          colour, a perpendicular bar shows the fork head, and an arrow
    //          with an arrowhead points at the holder's circle.
    for (let i = 0; i < N; i++) {
      const fp = forkPos[i];
      const restX = fp.x, restY = fp.y;
      const state    = this.forkStates.get(i) || 0;
      const holderId = this.forkHolders.get(i);

      if (state === 0 || holderId === undefined) {
        // FREE — lay the fork along the edge (tangent direction)
        const tx = fp.tx, ty = fp.ty;
        ctx.strokeStyle = "#7a7aa0";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(restX - tx * 13, restY - ty * 13);
        ctx.lineTo(restX + tx * 13, restY + ty * 13);
        ctx.stroke();
        // Label — slightly toward centre
        const cdx = cx - restX, cdy = cy - restY;
        const clen = Math.hypot(cdx, cdy) || 1;
        const lx = restX + (cdx / clen) * 14;
        const ly = restY + (cdy / clen) * 14;
        ctx.fillStyle = "#9a9abc";
        ctx.font = "10px monospace";
        ctx.textAlign = "center";
        ctx.fillText("F" + i, lx, ly);
      } else {
        // HELD
        const holder = philoPos[holderId];
        if (!holder) continue;
        const dx = holder.x - restX;
        const dy = holder.y - restY;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist, uy = dy / dist;

        // Fork bar at 30 % along rest→holder (close to rest) so the arrow
        // shaft has plenty of room. Arrow head sits a fixed pixel margin
        // OUTSIDE the philosopher's circle (radius 22) so the arrowhead is
        // clearly visible and never inside the circle.
        const PHILO_RADIUS = 22;
        const ARROW_OUTSIDE_GAP = 8;       // gap between arrow tip and circle edge
        const endPxFromHolder = PHILO_RADIUS + ARROW_OUTSIDE_GAP;  // 30
        const forkFrac      = 0.30;        // bar near rest, leaves room for a long shaft
        const startFrac     = forkFrac + 0.05;  // shaft starts just past the bar
        let   endFrac       = 1 - endPxFromHolder / dist;
        // Guarantee a visibly long shaft. On small canvases the geometry
        // gets squeezed; we keep the shaft at least 20 % of dist long even
        // if that means the arrowhead lands just inside the circle.
        const MIN_SHAFT_FRAC = 0.20;
        if (endFrac < startFrac + MIN_SHAFT_FRAC) endFrac = startFrac + MIN_SHAFT_FRAC;

        const forkX = restX + ux * dist * forkFrac;
        const forkY = restY + uy * dist * forkFrac;
        const color = PHILO_COLORS[holderId];

        // Fork bar — perpendicular to the rest→holder line.
        // Bar half-length scales with dist so it stays proportional.
        const barHalf = Math.max(6, Math.min(12, dist * 0.15));
        const px = -uy, py = ux;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(forkX - px * barHalf, forkY - py * barHalf);
        ctx.lineTo(forkX + px * barHalf, forkY + py * barHalf);
        ctx.stroke();

        // Arrow shaft — from past the fork bar toward the holder.
        const shaftStartX = restX + ux * dist * startFrac;
        const shaftStartY = restY + uy * dist * startFrac;
        const shaftEndX   = restX + ux * dist * endFrac;
        const shaftEndY   = restY + uy * dist * endFrac;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(shaftStartX, shaftStartY);
        ctx.lineTo(shaftEndX, shaftEndY);
        ctx.stroke();

        // Arrowhead
        const ah = 9;
        const ang = Math.atan2(shaftEndY - shaftStartY, shaftEndX - shaftStartX);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(shaftEndX, shaftEndY);
        ctx.lineTo(shaftEndX - ah * Math.cos(ang - Math.PI / 6),
                   shaftEndY - ah * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(shaftEndX - ah * Math.cos(ang + Math.PI / 6),
                   shaftEndY - ah * Math.sin(ang + Math.PI / 6));
        ctx.closePath();
        ctx.fill();

        // Fork label — at rest position, so you can still see where the
        // fork is "supposed to live" when free.
        ctx.fillStyle = color;
        ctx.font = "10px monospace";
        ctx.textAlign = "center";
        const cdx = cx - restX, cdy = cy - restY;
        const clen = Math.hypot(cdx, cdy) || 1;
        ctx.fillText("F" + i,
                     restX + (cdx / clen) * 14,
                     restY + (cdy / clen) * 14);
      }
    }

    // Philosophers --------------------------------------------------------
    ctx.textAlign = "center";
    for (let i = 0; i < N; i++) {
      const p = philoPos[i];
      const state = this.philoStates.get(i) ?? 0;
      const base  = PHILO_COLORS[i];

      // Outer circle — philosopher's base colour, thickness by state
      ctx.strokeStyle = base;
      ctx.lineWidth = state === 2 ? 3 : (state === 1 ? 2 : 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 22, 0, Math.PI * 2);
      ctx.stroke();

      // Inner state dot
      ctx.fillStyle = STATE_INNER[state];
      ctx.beginPath();
      ctx.arc(p.x, p.y, state === 2 ? 10 : 6, 0, Math.PI * 2);
      ctx.fill();

      // Labels
      ctx.fillStyle = base;
      ctx.font = "bold 13px monospace";
      ctx.fillText("P" + i, p.x, p.y + 4);
      ctx.font = "9px monospace";
      ctx.fillText(STATE_NAME[state], p.x, p.y + 36);
    }
  }

  // Shared AIOS/Protocol dispatch used by both evalExpr CallExpr and
  // _callBuiltin (CallStmt). args are pre-evaluated. Returns
  // { handled: true, value } when matched, or { handled: false }.
  _dispatchAiosProtocol(name, args, env) {
    const senderName = (env && env.__currentActor) || null;
    switch (name) {
      case "aios_register_service":
        this.aiosRegisterService(args[0], args[1]);
        return { handled: true, value: null };
      case "aios_emit":
        this.aiosEmit(args[0]);
        return { handled: true, value: null };
      case "aios_services":
        return { handled: true, value: this.aiosServicesString() };
      case "aios_events":
        return { handled: true, value: this.aiosEventsString() };
      case "aios_now": {
        const alias = String(args[0]);
        const method = String(args[1]);
        const rest = args.slice(2);
        const target = this.aiosResolve(alias);
        const slotId = this.newReplySlot();
        this.send(target, method, rest, false, senderName, slotId);
        const reply = this.drainUntilSlot(slotId);
        this.protocolObserveAll(alias, method);
        return { handled: true, value: reply };
      }
      case "aios_future": {
        const alias = String(args[0]);
        const method = String(args[1]);
        const rest = args.slice(2);
        const target = this.aiosResolve(alias);
        const slotId = this.newReplySlot();
        this.send(target, method, rest, false, senderName, slotId);
        return { handled: true, value: { __future: true, slotId,
                 _aios_meta: { alias, method, args: rest } } };
      }
      case "protocol_define":
        this.protocolDefine(args[0], args[1]);
        return { handled: true, value: null };
      case "protocol_start":
        return { handled: true, value: this.protocolStart(String(args[0])) };
      case "protocol_state":
        return { handled: true, value: this.protocolStateString(String(args[0])) };
      case "protocol_end":
        this.protocolEnd(String(args[0]));
        return { handled: true, value: null };
      case "protocol_events":
        return { handled: true, value: this.protocolEventsString() };
    }
    return { handled: false };
  }

  // ---- AIOS coordination helpers ------------------------------------
  aiosResolve(alias) {
    return this._aiosServices.get(alias) || alias;
  }
  aiosEmit(msg) { this._aiosEvents.push("[EMIT] " + String(msg)); }
  aiosRegisterService(alias, actorName) {
    this._aiosServices.set(String(alias), String(actorName));
    this._aiosEvents.push(`[REGISTER] ${alias} -> ${actorName}`);
  }
  aiosServicesString() {
    return "[" + Array.from(this._aiosServices.entries())
      .map(([a, n]) => `${a}=${n}`).join(", ") + "]";
  }
  aiosEventsString() { return this._aiosEvents.join("\n"); }

  protocolDefine(name, spec) {
    const steps = String(spec).split("->").map(s => s.trim()).filter(Boolean);
    this._protoDefs.set(String(name), steps);
    this._protoEvents.push(`[PROTO_DEF] ${name} = [${steps.join(", ")}]`);
  }
  protocolStart(name) {
    if (!this._protoDefs.has(name)) throw new Error("protocol_start: unknown " + name);
    this._protoSeq += 1;
    const sid = `proto-${this._protoSeq}-${Date.now()}`;
    this._protoActive.set(sid, { name, idx: 0, ended: false });
    this._protoEvents.push(`[PROTO_START] sid=${sid} proto=${name}`);
    return sid;
  }
  protocolObserveAll(actorAlias, method) {
    const step = `${actorAlias}.${method}`;
    for (const [, st] of this._protoActive) {
      if (st.ended) continue;
      const defn = this._protoDefs.get(st.name) || [];
      if (st.idx < defn.length && defn[st.idx] === step) st.idx += 1;
    }
  }
  protocolStateString(sid) {
    const st = this._protoActive.get(sid);
    if (!st) return `[PROTO_STATE] sid=${sid} (unknown)`;
    const defn = this._protoDefs.get(st.name) || [];
    const next = st.idx < defn.length ? defn[st.idx] : "(done)";
    const status = st.ended ? "ended" : "running";
    return `[PROTO_STATE] sid=${sid} proto=${st.name} progress=${st.idx}/${defn.length} next=${next} status=${status}`;
  }
  protocolEnd(sid) {
    const st = this._protoActive.get(sid);
    if (st) st.ended = true;
    this._protoEvents.push(`[PROTO_END] sid=${sid}`);
  }
  protocolEventsString() { return this._protoEvents.join("\n"); }

  // ---- AI integration -----------------------------------------------
  // Default: a synchronous mock provider so the cooperative sample runs
  // offline in any environment. To use a real provider, override this
  // method on a Runtime instance (the Node runner in run_cooperative.mjs
  // does this with execSync + curl).
  //
  // `provider` is an optional integer (1=gemini, 2=anthropic/claude,
  // 3=openai) or a canonical lowercase string.  null / undefined / 0
  // means "auto-select".  Mirrors python-aipl/aipl_ai.py:_resolve_provider.
  _aiCall(prompt, system = null, provider = null) {
    const sysTag = system ? ` sys=(${String(system).slice(0, 12)}...)` : "";
    const head = String(prompt ?? "").slice(0, 60);
    const provTag = provider ? ` provider=${this._resolveProvider(provider)}` : "";
    return `[mock${provTag}] reply${sysTag} for: ${head}`;
  }

  // ---- Text file I/O ---------------------------------------------------
  // Lazily resolve Node's `fs` so the same runtime file works in the
  // browser (where there is no filesystem).  The browser path returns
  // null and each I/O helper throws a clear "not available" error.
  //
  // Resolution prefers an `fs` module injected by the embedder (used
  // by node-aipl-server) so we don't have to dance around ESM/CJS
  // boundaries; otherwise we look for the Node-global `__aipl_fs`
  // hook.  Both browsers and tests can shim a fake `fs` on the
  // runtime via `runtime.injectFs(fs)`.
  injectFs(fs) {
    this.__fsCached = fs || null;
  }
  _fs() {
    if (this.__fsCached !== undefined) return this.__fsCached;
    if (typeof globalThis !== "undefined" && globalThis.__aipl_fs) {
      this.__fsCached = globalThis.__aipl_fs;
      return this.__fsCached;
    }
    this.__fsCached = null;
    return null;
  }
  _fsRead(path) {
    const fs = this._fs();
    if (!fs) throw new Error("read_file: filesystem not available in browser");
    return fs.readFileSync(String(path), "utf8");
  }
  _fsWrite(path, content, append) {
    const fs = this._fs();
    if (!fs) throw new Error((append ? "append_file" : "write_file") +
      ": filesystem not available in browser");
    if (append) {
      fs.appendFileSync(String(path), String(content), "utf8");
    } else {
      fs.writeFileSync(String(path), String(content), "utf8");
    }
    return 1;
  }
  _fsExists(path) {
    const fs = this._fs();
    if (!fs) return 0;
    return fs.existsSync(String(path)) ? 1 : 0;
  }

  // ---- Image I/O (PPM P6, RGBA in memory) -----------------------------
  // An image is a plain object { __image: true, w, h, px } where `px` is a
  // Uint8Array of length w*h*4 (RGBA, row-major).
  _imageCreate(args) {
    const w = args[0] | 0, h = args[1] | 0;
    const r = args[2] | 0, g = args[3] | 0, b = args[4] | 0;
    const a = args.length >= 6 ? (args[5] | 0) : 255;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      px[i*4] = r; px[i*4+1] = g; px[i*4+2] = b; px[i*4+3] = a;
    }
    return { __image: true, w, h, px };
  }
  _imageSave(img, path) {
    const fs = this._fs();
    if (!fs) throw new Error("image_save: filesystem not available in browser");
    if (!img || !img.__image) throw new Error("image_save: not an image");
    const header = `P6\n${img.w} ${img.h}\n255\n`;
    // Pack RGB (drop A) into a fresh buffer.
    const rgb = Buffer.alloc(img.w * img.h * 3);
    for (let i = 0; i < img.w * img.h; i++) {
      rgb[i*3]   = img.px[i*4];
      rgb[i*3+1] = img.px[i*4+1];
      rgb[i*3+2] = img.px[i*4+2];
    }
    fs.writeFileSync(String(path), Buffer.concat([Buffer.from(header, "utf8"), rgb]));
    return 1;
  }
  _imageLoad(path) {
    const fs = this._fs();
    if (!fs) throw new Error("image_load: filesystem not available in browser");
    const buf = fs.readFileSync(String(path));
    // Parse PPM header: token-based, comments start with '#'.
    let i = 0;
    const skip = () => {
      while (i < buf.length) {
        const c = String.fromCharCode(buf[i]);
        if (c === '#') {
          while (i < buf.length && buf[i] !== 0x0a) i++;
          i++;
        } else if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
          i++;
        } else break;
      }
    };
    const token = () => {
      skip();
      let s = "";
      while (i < buf.length) {
        const c = String.fromCharCode(buf[i]);
        if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { i++; break; }
        s += c; i++;
      }
      return s;
    };
    const magic = token();
    if (magic !== "P6") throw new Error("image_load: unsupported PPM magic '" + magic + "'");
    const w = parseInt(token(), 10);
    const h = parseInt(token(), 10);
    const maxv = parseInt(token(), 10);
    if (maxv !== 255) throw new Error("image_load: PPM maxval must be 255");
    const px = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      px[p*4]   = buf[i++];
      px[p*4+1] = buf[i++];
      px[p*4+2] = buf[i++];
      px[p*4+3] = 255;
    }
    return { __image: true, w, h, px };
  }
  _imageSize(img) {
    if (!img || !img.__image) throw new Error("image_size: not an image");
    return [img.w, img.h];   // surfaces as an array (no AIPL tuple type in JS-B)
  }
  _imagePixel(img, x, y) {
    if (!img || !img.__image) throw new Error("image_pixel: not an image");
    x |= 0; y |= 0;
    if (x < 0 || x >= img.w || y < 0 || y >= img.h)
      throw new Error(`image_pixel: (${x}, ${y}) out of bounds (${img.w}x${img.h})`);
    const off = (y * img.w + x) * 4;
    return [img.px[off], img.px[off+1], img.px[off+2], img.px[off+3]];
  }
  _imageSetPixel(args) {
    const img = args[0];
    if (!img || !img.__image) throw new Error("image_set_pixel: not an image");
    const x = args[1] | 0, y = args[2] | 0;
    const r = args[3] | 0, g = args[4] | 0, b = args[5] | 0;
    const a = args.length >= 7 ? (args[6] | 0) : 255;
    if (x < 0 || x >= img.w || y < 0 || y >= img.h)
      throw new Error(`image_set_pixel: (${x}, ${y}) out of bounds (${img.w}x${img.h})`);
    const off = (y * img.w + x) * 4;
    img.px[off] = r; img.px[off+1] = g; img.px[off+2] = b; img.px[off+3] = a;
    return 1;
  }

  // Map AIPL-side provider id (int 1..3 / string) to canonical name.
  _resolveProvider(p) {
    if (p == null || p === 0) return null;
    if (typeof p === "number" || /^[0-9]+$/.test(String(p))) {
      const n = Number(p);
      if (n === 1) return "gemini";
      if (n === 2) return "anthropic";
      if (n === 3) return "openai";
      return null;
    }
    const s = String(p).trim().toLowerCase();
    if (s === "auto" || s === "") return null;
    if (s === "claude" || s === "claudecode" || s === "claude-code") return "anthropic";
    if (s === "gpt" || s === "chatgpt") return "openai";
    if (s === "gemini" || s === "anthropic" || s === "openai" || s === "mock") return s;
    return null;
  }

  // Split an args array into (provider | null, rest).  If the first
  // arg looks like a provider id (int 1..3 or a known provider
  // string), strip it.  Mirrors python-aipl:_split_provider.
  _splitProvider(args) {
    if (!args || args.length === 0) return { provider: null, rest: args };
    const a0 = args[0];
    if (typeof a0 === "number" && [0, 1, 2, 3].includes(a0)) {
      return { provider: a0 === 0 ? null : a0, rest: args.slice(1) };
    }
    if (typeof a0 === "string" && args.length >= 2) {
      const resolved = this._resolveProvider(a0);
      if (resolved !== null) return { provider: a0, rest: args.slice(1) };
    }
    return { provider: null, rest: args };
  }

  evalTarget(target, env) {
    if (typeof target === "string") {
      if (target === "self") return env.__currentActor || "self";
      if (target in env) return env[target];
      if (this.actors.has(target)) return target;
      return target;
    }
    throw new Error("Unsupported send target: " + JSON.stringify(target));
  }

  evalSelect(stmt, env) {
    const actorName = env.__currentActor;
    if (!actorName) throw new Error("select used outside actor method");
    const actor = this.actors.get(actorName);
    if (!actor) throw new Error("current actor not found: " + actorName);

    let matchedIndex = -1, matchedCase = null, matchedMsg = null;
    for (let i = 0; i < actor.mailbox.length; i++) {
      const msg = actor.mailbox[i];
      for (const c of stmt.cases) {
        if (msg.methodName === c.method) {
          matchedIndex = i; matchedCase = c; matchedMsg = msg;
          break;
        }
      }
      if (matchedCase) break;
    }

    if (matchedCase) {
      actor.mailbox.splice(matchedIndex, 1);
      const localEnv = { ...env };
      matchedCase.params.forEach((p, i) => { localEnv[p] = matchedMsg.args[i]; });
      // case 本体の reply は「選ばれたメッセージ」への返信である。
      // Reply は actor.__currentSlotId を見て呼び出し元の slot を埋めるので、
      // 本体の実行中だけ、受け取ったメッセージの slotId に差し替える。
      // これをしないと select を書いたメソッド自身の slot（多くは無い）を
      // 見てしまい、`print(now w.job(1))` が
      // 「now deadlock: slot not fulfilled」で失敗する。
      const savedSlot = actor.__currentSlotId;
      actor.__currentSlotId = matchedMsg.slotId || null;
      let last = null;
      try {
        for (const st of matchedCase.body.statements) last = this.evalStmt(st, localEnv);
      } finally {
        actor.__currentSlotId = savedSlot;
      }
      return last;
    }

    if (stmt.timeoutBody) {
      this.print(`[timeout] ${stmt.timeoutMs}ms`);
      let last = null;
      for (const st of stmt.timeoutBody.statements) last = this.evalStmt(st, env);
      return last;
    }
    return null;
  }

  evalExpr(expr, env) {
    switch (expr.type) {
      case "IntLit":    return expr.value;
      case "BoolLit":   return expr.value;
      case "FloatLit":  return expr.value;
      case "StringLit": return expr.value;

      case "Var":
        // `self` inside a method body resolves to the current actor
        // name (parity with the OCaml/Py-I runtimes).  Previously
        // only `send self.foo()` worked because evalTarget knew the
        // keyword — passing `self` as an argument failed.
        if (expr.name === "self" && env.__currentActor) {
          return env.__currentActor;
        }
        if (expr.name in env) return env[expr.name];
        if (this.actors.has(expr.name)) return expr.name;
        throw new Error("Unknown var: " + expr.name);

      case "Binop": {
        const l = this.evalExpr(expr.left, env);
        const r = this.evalExpr(expr.right, env);
        switch (expr.op) {
          // `++` は文字列連結（両辺を文字列化する全域関数）。
          // OCaml 版で `+` から分離した演算子。
          case "++": return this._toStr(l) + this._toStr(r);
          case "+":
            // `+` は数値専用。文字列連結は `++`（OCaml 版と同じ分離）。
            if (typeof l === "string" || typeof r === "string") {
              throw new Error(
                "`+` は数値専用です。文字列の連結には `++` を使ってください " +
                "(left=" + typeof l + ", right=" + typeof r + ")");
            }
            return l + r;
          case "-":  return l - r;
          case "*":  return l * r;
          case "/":  return l / r;
          // 比較は真偽値を返す（OCaml 版に合わせる）。従来は 1/0 だったので
          // `"b = " ++ (1 < 2)` が "b = 1" になり出力が食い違っていた。
          // 条件判定は if (c) の真偽値判定なので 0/false ともに偽で、
          // 数値文脈でも JS は true を 1 として扱うため既存コードは壊れない。
          case "==": return l === r;
          case "!=": return l !== r;
          case "<":  return l <  r;
          case ">":  return l >  r;
          case "<=": return l <= r;
          case ">=": return l >= r;
        }
        throw new Error("Unsupported op: " + expr.op);
      }

      case "CallExpr": {
        const args = expr.args.map(a => this.evalExpr(a, env));
        switch (expr.name) {
          case "cos":   return Math.cos(args[0]);
          case "sin":   return Math.sin(args[0]);
          case "sqrt":  return Math.sqrt(args[0]);
          case "abs":   return Math.abs(args[0]);
          case "floor": return Math.floor(args[0]);
          case "rand":  return Math.floor(Math.random() * (Number(args[0]) || 1));
          case "randf": return Math.random() * (Number(args[0]) || 1);
          case "ai_call": {
            // ai_call([provider,] prompt) — provider optional.
            const sp = this._splitProvider(args);
            return this._aiCall(sp.rest[0], null, sp.provider);
          }
          case "ai_call_with_system": {
            // ai_call_with_system([provider,] system, prompt)
            const sp = this._splitProvider(args);
            return this._aiCall(sp.rest[1], sp.rest[0], sp.provider);
          }
          case "prod_speed":          return this._prodSpeed;
          case "cons_speed":          return this._consSpeed;

          /* ---- text file I/O ----
             Available in Node (JS-N) via `fs`. In the browser (JS-B)
             these throw — the host UI has no filesystem access. */
          case "read_file":   return this._fsRead(args[0]);
          case "write_file":  return this._fsWrite(args[0], args[1], /*append*/ false);
          case "append_file": return this._fsWrite(args[0], args[1], /*append*/ true);
          case "file_exists": return this._fsExists(args[0]);

          /* ---- image I/O (PPM P6 backend) ----
             Same fs gating as text I/O. */
          case "image_create":    return this._imageCreate(args);
          case "image_load":      return this._imageLoad(args[0]);
          case "image_save":      return this._imageSave(args[0], args[1]);
          case "image_size":      return this._imageSize(args[0]);
          case "image_pixel":     return this._imagePixel(args[0], args[1], args[2]);
          case "image_set_pixel": return this._imageSetPixel(args);

          // ── Next-gen primitives (CE-11 + DR-10/11/12/13) ─────
          // CallExpr path: returns value (CallStmt path is in the
          // other switch, around line 414).
          case "grant_cap":        return this._nextgen_grant_cap(args);
          case "revoke_cap":       return this._nextgen_revoke_cap(args);
          case "has_cap":          return this._nextgen_has_cap(args);
          case "current_caps":     return this._nextgen_current_caps();
          case "check_capability": return this._nextgen_check_capability(args);
          case "current_region":     return this._nextgen_current_region();
          case "region_chain":       return this._nextgen_region_chain();
          case "route_for_region":   return this._nextgen_route_for_region(args);
          case "failover_region":    return this._nextgen_failover_region(args);
          case "regions_available":  return this._nextgen_regions_available();
          case "pool_create":        return this._nextgen_pool_create(args);
          case "pool_pick":          return this._nextgen_pool_pick(args);
          case "pool_size":          return this._nextgen_pool_size(args);
          case "pool_destroy":       return this._nextgen_pool_destroy(args);
          case "crdt_gcounter_new":      return this._nextgen_crdt_gcounter_new();
          case "crdt_gcounter_inc":      return this._nextgen_crdt_gcounter_inc(args);
          case "crdt_gcounter_value":    return this._nextgen_crdt_gcounter_value(args);
          case "crdt_gcounter_merge":    return this._nextgen_crdt_gcounter_merge(args);
          case "crdt_orset_new":         return this._nextgen_crdt_orset_new();
          case "crdt_orset_add":         return this._nextgen_crdt_orset_add(args);
          case "crdt_orset_remove":      return this._nextgen_crdt_orset_remove(args);
          case "crdt_orset_contains":    return this._nextgen_crdt_orset_contains(args);
          case "crdt_orset_values":      return this._nextgen_crdt_orset_values(args);
          case "crdt_orset_merge":       return this._nextgen_crdt_orset_merge(args);
          case "crdt_lww_new":           return this._nextgen_crdt_lww_new(args);
          case "crdt_lww_write":         return this._nextgen_crdt_lww_write(args);
          case "crdt_lww_value":         return this._nextgen_crdt_lww_value(args);
          case "crdt_lww_merge":         return this._nextgen_crdt_lww_merge(args);
          case "crdt_replicate":         return this._nextgen_crdt_replicate(args);

          default: {
            // AIOS / protocol builtins (shared with CallStmt)
            const ap = this._dispatchAiosProtocol(expr.name, args, env);
            if (ap.handled) return ap.value;
            // 文として登録した組込み（is_ok / value / acquire など）は
            // 式の位置からも呼べなければならない。ここへ落として拾う。
            if (["is_ok", "timed_out", "value", "acquire", "release"]
                  .includes(expr.name)) {
              return this._callBuiltin(expr.name, args, env);
            }
            throw new Error("Unknown function: " + expr.name);
          }
        }
      }

      case "Now": {
        const senderName = env.__currentActor || null;
        const target = this.evalTarget(expr.target, env);
        const args = expr.args.map(a => this.evalExpr(a, env));
        const slotId = this.newReplySlot();
        this.send(target, expr.method, args, false, senderName, slotId);
        if (!expr.deadline) return this.drainUntilSlot(slotId);
        const r = this.drainUntilSlotTimed(slotId, expr.deadline.ms);
        // else を書かなければ result<τ>。成功したかどうかを値に持たせる。
        if (expr.deadline.alt === null || expr.deadline.alt === undefined) {
          return { __result: true, ok: r.ok, value: r.ok ? r.value : null };
        }
        return r.ok ? r.value : this.evalExpr(expr.deadline.alt, env);
      }

      case "Future": {
        const senderName = env.__currentActor || null;
        const target = this.evalTarget(expr.target, env);
        const args = expr.args.map(a => this.evalExpr(a, env));
        const slotId = this.newReplySlot();
        this.send(target, expr.method, args, false, senderName, slotId);
        return { __future: true, slotId };
      }

      case "Await": {
        const fut = this.evalExpr(expr.expr, env);
        if (fut && typeof fut === "object" && fut.__future) {
          if (expr.deadline) {
            const r = this.drainUntilSlotTimed(fut.slotId, expr.deadline.ms);
            if (expr.deadline.alt === null || expr.deadline.alt === undefined) {
              return { __result: true, ok: r.ok, value: r.ok ? r.value : null };
            }
            if (!r.ok) return this.evalExpr(expr.deadline.alt, env);
            if (fut._aios_meta) {
              this.protocolObserveAll(fut._aios_meta.alias, fut._aios_meta.method);
            }
            return r.value;
          }
          const value = this.drainUntilSlot(fut.slotId);
          if (fut._aios_meta) {
            this.protocolObserveAll(fut._aios_meta.alias, fut._aios_meta.method);
          }
          return value;
        }
        // await on a plain value is a no-op (parity with Python)
        return fut;
      }

      case "NewExpr": {
        const name = expr.className.toLowerCase() + this.nextId++;
        const initArgs = (expr.args || []).map(a => this.evalExpr(a, env));
        this.createActor(name, expr.className, initArgs);
        return name;
      }

      case "ArraySized": {
        // Build an N-dim nested array filled with `init` (or 0).
        const dims = expr.dims.map(d => this.evalExpr(d, env) | 0);
        const fill = expr.init === null
          ? 0
          : this.evalExpr(expr.init, env);
        const build = (ds) => {
          if (ds.length === 0) return fill;
          const n = ds[0];
          const rest = ds.slice(1);
          const arr = new Array(n);
          for (let i = 0; i < n; i++) arr[i] = build(rest);
          return arr;
        };
        return build(dims);
      }

      case "IndexExpr": {
        // a[i][j]…
        let v = env[expr.name];
        if (v === undefined && this.actors.has(expr.name)) {
          // Indexing an actor name doesn't make sense — fall through.
        }
        for (const d of expr.dims) {
          const idx = this.evalExpr(d, env) | 0;
          if (!Array.isArray(v))
            throw new Error("IndexExpr on non-array: " + expr.name);
          v = v[idx];
        }
        return v;
      }

      default:
        throw new Error("Unsupported expr: " + expr.type);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Next-gen primitives (CE-11 + DR-10/11/12/13) — shared by both
  // JS-Browser and JS-Node runtimes since server.mjs reuses this
  // file.  Mirror Py-I's aipl_dist.py / OCaml's aipl_dist.ml
  // shapes; web idioms substitute pthread/TLS with per-Runtime
  // state.
  // ─────────────────────────────────────────────────────────────

  // CE-11: capability set is per-Runtime-instance (one set per
  // tab / one set per Node process worker).  Seeded from
  // AIPL_CAP_GRANT in Node, or the runtime's `?cap=…` URL query
  // in the browser bootstrap (see main.js for the URL plumbing).
  _ng_caps() {
    if (!this._cap_set) {
      const seed = (typeof process !== "undefined" && process.env && process.env.AIPL_CAP_GRANT)
                   || (typeof window !== "undefined" && window.__AIPL_CAP_GRANT)
                   || "";
      this._cap_set = new Set(seed.split(",").map(s => s.trim()).filter(Boolean));
    }
    return this._cap_set;
  }
  _ng_cap_strict() {
    const v = (typeof process !== "undefined" && process.env && process.env.AIPL_CAP_STRICT)
              || (typeof window !== "undefined" && window.__AIPL_CAP_STRICT)
              || "0";
    return v === "1";
  }
  _ng_log_event(event, fields) {
    /* Best-effort structured log: in Node, append NDJSON to
       AIPL_DIST_LOG_FILE; in browser, console.debug as JSON.
       Reuses `_fs()` so server.mjs's injected fs module works
       under both CJS and pure-ESM hosts. */
    const ts_ns = (Date.now() * 1e6) | 0;
    const rec = Object.assign({ ts_ns, event }, fields || {});
    if (typeof process !== "undefined" && process.env && process.env.AIPL_DIST_LOG_FILE) {
      const fs = this._fs();
      if (fs && fs.appendFileSync) {
        try {
          fs.appendFileSync(process.env.AIPL_DIST_LOG_FILE, JSON.stringify(rec) + "\n");
          return;
        } catch (_) { /* fall through */ }
      }
    }
    if (typeof console !== "undefined" && console.debug) {
      console.debug("[aipl_log]", rec);
    }
  }
  _nextgen_grant_cap(args) {
    const name = String(args[0] || "");
    const s = this._ng_caps();
    if (s.has(name)) return false;
    s.add(name);
    this._ng_log_event("cap_granted", { cap: name });
    return true;
  }
  _nextgen_revoke_cap(args) {
    const name = String(args[0] || "");
    const s = this._ng_caps();
    if (!s.has(name)) return false;
    s.delete(name);
    this._ng_log_event("cap_revoked", { cap: name });
    return true;
  }
  _nextgen_has_cap(args) {
    return this._ng_caps().has(String(args[0] || ""));
  }
  _nextgen_current_caps() {
    return [...this._ng_caps()].sort().join(" ");
  }
  _nextgen_check_capability(args) {
    const name = String(args[0] || "");
    const s = this._ng_caps();
    if (s.has(name)) return true;
    this._ng_log_event("cap_violation", { missing: name, held: [...s].join(",") });
    if (this._ng_cap_strict()) {
      throw new Error(`capability denied: missing [${name}] (held: [${[...s].join("; ")}])`);
    }
    return true;
  }

  // DR-12: multi-region failover via env / window globals.
  _nextgen_current_region() {
    return (typeof process !== "undefined" && process.env && process.env.AIPL_REGION)
        || (typeof window !== "undefined" && window.__AIPL_REGION)
        || "local";
  }
  _nextgen_region_chain() {
    const raw = (typeof process !== "undefined" && process.env && process.env.AIPL_REGION_FAILOVER)
             || (typeof window !== "undefined" && window.__AIPL_REGION_FAILOVER)
             || "";
    return raw;
  }
  _nextgen_route_for_region(args) {
    const actor  = String(args[0] || "");
    const region = String(args[1] || this._nextgen_current_region());
    const key    = `AIPL_ROUTE_REGION_${region}`;
    const raw    = (typeof process !== "undefined" && process.env && process.env[key])
                || (typeof window !== "undefined" && window["__" + key])
                || "";
    for (const spec of raw.split(",")) {
      const [n, tag] = spec.split(":").map(s => s && s.trim());
      if (n === actor && tag) return tag;
    }
    return "";
  }
  _nextgen_failover_region(args) {
    const actor = String(args[0] || "");
    const chain = (this._nextgen_region_chain() || this._nextgen_current_region())
                  .split(",").map(s => s.trim()).filter(Boolean);
    const primary = String(args[1] || (chain[0] || "local"));
    const tried = [];
    for (const r of chain) {
      tried.push(r);
      const tag = this._nextgen_route_for_region([actor, r]);
      if (tag) {
        if (r !== primary) {
          this._ng_log_event("region_failover", {
            actor, from_region: primary, to_region: r,
            chain: tried.join(","),
          });
        }
        return r;
      }
    }
    this._ng_log_event("region_failover_failed", { actor, tried: tried.join(",") });
    return "";
  }
  _nextgen_regions_available() {
    const env = (typeof process !== "undefined" && process.env) || {};
    const wnd = (typeof window !== "undefined" && window) || {};
    const out = new Set();
    const prefix = "AIPL_ROUTE_REGION_";
    for (const k of Object.keys(env)) if (k.startsWith(prefix) && env[k]) out.add(k.slice(prefix.length));
    for (const k of Object.keys(wnd)) if (k.startsWith("__" + prefix) && wnd[k]) out.add(k.slice(("__" + prefix).length));
    return [...out].sort().join(" ");
  }

  // DR-10: CRDTs as opaque ids backed by an internal Map.
  _ng_crdt_table() {
    if (!this._crdt_t) this._crdt_t = new Map();
    if (this._crdt_n === undefined) this._crdt_n = 0;
    return this._crdt_t;
  }
  _ng_crdt_replica() {
    return (typeof process !== "undefined" && process.env && process.env.AIPL_DIST_REPLICA_ID)
        || (typeof window !== "undefined" && window.__AIPL_DIST_REPLICA_ID)
        || (typeof process !== "undefined" && process.title)
        || "node-0";
  }
  _ng_crdt_fresh(prefix, obj) {
    const id = `${prefix}#${++this._crdt_n}`;
    this._ng_crdt_table().set(id, obj);
    return id;
  }
  _nextgen_crdt_gcounter_new() {
    return this._ng_crdt_fresh("gc", { kind: "GCounter", counts: {} });
  }
  _nextgen_crdt_gcounter_inc(args) {
    const id = String(args[0] || ""); const n = Number(args[1] !== undefined ? args[1] : 1);
    const o = this._ng_crdt_table().get(id);
    if (!o || o.kind !== "GCounter" || n < 0) return id;
    const r = this._ng_crdt_replica();
    o.counts[r] = (o.counts[r] | 0) + (n | 0);
    return id;
  }
  _nextgen_crdt_gcounter_value(args) {
    const o = this._ng_crdt_table().get(String(args[0] || ""));
    return (o && o.kind === "GCounter")
      ? Object.values(o.counts).reduce((a, b) => a + b, 0) : 0;
  }
  _nextgen_crdt_gcounter_merge(args) {
    const a = this._ng_crdt_table().get(String(args[0] || ""));
    const b = this._ng_crdt_table().get(String(args[1] || ""));
    if (!a || !b) return "";
    const out = { kind: "GCounter", counts: {} };
    for (const k of new Set([...Object.keys(a.counts), ...Object.keys(b.counts)])) {
      out.counts[k] = Math.max(a.counts[k] | 0, b.counts[k] | 0);
    }
    return this._ng_crdt_fresh("gc", out);
  }
  _nextgen_crdt_orset_new() {
    return this._ng_crdt_fresh("os", { kind: "ORSet", adds: {}, removes: {} });
  }
  _nextgen_crdt_orset_add(args) {
    const id = String(args[0] || ""); const e = String(args[1] || "");
    const o = this._ng_crdt_table().get(id);
    if (!o || o.kind !== "ORSet") return id;
    if (!o.adds[e]) o.adds[e] = [];
    o.adds[e].push(`${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    return id;
  }
  _nextgen_crdt_orset_remove(args) {
    const id = String(args[0] || ""); const e = String(args[1] || "");
    const o = this._ng_crdt_table().get(id);
    if (!o || o.kind !== "ORSet" || !o.adds[e]) return id;
    if (!o.removes[e]) o.removes[e] = [];
    o.removes[e].push(...o.adds[e]);
    return id;
  }
  _nextgen_crdt_orset_contains(args) {
    const id = String(args[0] || ""); const e = String(args[1] || "");
    const o = this._ng_crdt_table().get(id);
    if (!o || o.kind !== "ORSet") return false;
    const adds = new Set(o.adds[e] || []);
    const rems = new Set(o.removes[e] || []);
    for (const tag of adds) if (!rems.has(tag)) return true;
    return false;
  }
  _nextgen_crdt_orset_values(args) {
    const id = String(args[0] || "");
    const o = this._ng_crdt_table().get(id);
    if (!o || o.kind !== "ORSet") return "";
    const out = [];
    for (const e of Object.keys(o.adds)) {
      if (this._nextgen_crdt_orset_contains([id, e])) out.push(e);
    }
    return out.join(" ");
  }
  _nextgen_crdt_orset_merge(args) {
    const a = this._ng_crdt_table().get(String(args[0] || ""));
    const b = this._ng_crdt_table().get(String(args[1] || ""));
    if (!a || !b) return "";
    const out = { kind: "ORSet", adds: {}, removes: {} };
    const mergeBag = (x, y) => {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      const res = {};
      for (const k of keys) res[k] = [...new Set([...(x[k] || []), ...(y[k] || [])])];
      return res;
    };
    out.adds = mergeBag(a.adds, b.adds);
    out.removes = mergeBag(a.removes, b.removes);
    return this._ng_crdt_fresh("os", out);
  }
  _nextgen_crdt_lww_new(args) {
    return this._ng_crdt_fresh("lv", {
      kind: "LWWReg",
      value: String(args[0] !== undefined ? args[0] : ""),
      ts: 0, replica: this._ng_crdt_replica(),
    });
  }
  _nextgen_crdt_lww_write(args) {
    const id = String(args[0] || "");
    const o = this._ng_crdt_table().get(id);
    if (!o || o.kind !== "LWWReg") return id;
    o.value = String(args[1] !== undefined ? args[1] : "");
    o.ts = Date.now();
    o.replica = this._ng_crdt_replica();
    return id;
  }
  _nextgen_crdt_lww_value(args) {
    const o = this._ng_crdt_table().get(String(args[0] || ""));
    return (o && o.kind === "LWWReg") ? o.value : "";
  }
  _nextgen_crdt_lww_merge(args) {
    const a = this._ng_crdt_table().get(String(args[0] || ""));
    const b = this._ng_crdt_table().get(String(args[1] || ""));
    if (!a || !b) return "";
    let w = a;
    if (b.ts > a.ts) w = b;
    else if (b.ts === a.ts && b.replica > a.replica) w = b;
    return this._ng_crdt_fresh("lv", Object.assign({}, w));
  }
  _nextgen_crdt_replicate(args) {
    const id = String(args[0] || "");
    const o = this._ng_crdt_table().get(id);
    if (!o) return;
    this._ng_log_event("crdt_replicate", {
      actor: id, kind: o.kind, replica: this._ng_crdt_replica(),
    });
  }

  // DR-13: pool with stub spawn / retire (the underlying actor
  // system varies between JS-B Worker and JS-N worker_threads;
  // wiring those callbacks is left to a follow-up).
  _ng_pool_table() {
    if (!this._pools) this._pools = new Map();
    return this._pools;
  }
  _nextgen_pool_create(args) {
    const cls = String(args[0] || ""); const minN = +args[1] || 0;
    const maxN = +args[2] || Math.max(minN, 4); const target = +args[3] || 4;
    const name = `pool::${cls}`;
    const t = this._ng_pool_table();
    if (t.has(name)) return name;
    t.set(name, { cls, members: [], minN, maxN, target, rr: 0 });
    this._ng_log_event("pool_created", { pool: name, cls, min: minN, max: maxN, target });
    return name;
  }
  _nextgen_pool_pick(args) {
    const p = this._ng_pool_table().get(String(args[0] || ""));
    if (!p || p.members.length === 0) return "";
    const i = p.rr % p.members.length;
    p.rr = (p.rr + 1) % p.members.length;
    return p.members[i];
  }
  _nextgen_pool_size(args) {
    const p = this._ng_pool_table().get(String(args[0] || ""));
    return p ? p.members.length : 0;
  }
  _nextgen_pool_destroy(args) {
    const name = String(args[0] || "");
    const t = this._ng_pool_table();
    if (!t.has(name)) return false;
    t.delete(name);
    this._ng_log_event("pool_destroyed", { pool: name });
    return true;
  }
}
