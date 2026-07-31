import { Runtime } from "./runtime.js";
import { runTypeCheck, checkReplyAndDeadlines } from "./typecheck.js";

export class Interpreter {
  constructor(printer) {
    this.runtime = new Runtime(printer);
    this.typeCheckEnabled = true;
  }

  setCanvas(canvas) {
    this.runtime.setCanvas(canvas);
  }

  runProgram(ast) {
    if (this.typeCheckEnabled) {
      try {
        runTypeCheck(ast);
      } catch (e) {
        // hard-fail (mirrors OCaml/C "type error" behavior)
        throw new Error("[type error] " + e.message);
      }
      // reply の線形性と期限の検査。既存のデモを止めないよう、
      // ここでは投げずに診断として表示する（OCaml 版の期限も既定は警告）。
      try {
        const diags = checkReplyAndDeadlines(ast, {
          strictDeadline: this.strictDeadline === true,
        });
        for (const d of diags) {
          this.runtime.print(`[type] ${d.where}: ${d.message}`);
        }
      } catch (_e) { /* 検査自体の失敗で実行を止めない */ }
    }
    this.runtime.reset();
    for (const cls of ast.classes) {
      this.runtime.registerClass(cls);
    }
    // Share a single top-level env across statements so global vars created
    // by one stmt (e.g. `var plan = now planner.plan(q);`) are visible to
    // later stmts (e.g. `print("[plan] " + plan);`).
    const topEnv = {};
    for (const st of ast.statements) {
      this.runtime.evalStmt(st, topEnv);
    }
    // Start all actor threads (setTimeout-based)
    this.runtime.scheduleAllActors();
  }
}
