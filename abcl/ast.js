export function Program(classes = [], statements = []) {
  return { type: "Program", classes, statements };
}

export function ClassDecl(name, methods, fields = []) {
  return { type: "ClassDecl", name, methods, fields };
}

export function VarField(name, expr) {
  return { type: "VarField", name, expr };
}

export function MethodDecl(name, params, body, ret, eff, paramTypes) {
  // ret: 戻り値型注釈の型名（`: T`）または null
  // eff: 効果注釈の名前配列（`!{a, b}`）または null
  return { type: "MethodDecl", name, params, body,
           ret: ret || null, eff: eff || null,
           paramTypes: paramTypes || null };
}

export function Seq(statements) {
  return { type: "Seq", statements };
}

export function VarDecl(name, expr) {
  return { type: "VarDecl", name, expr };
}

export function Assign(name, expr) {
  return { type: "Assign", name, expr };
}

export function Send(target, method, args, unsafe = false) {
  return { type: "Send", target, method, args, unsafe };
}

export function Print(expr) {
  return { type: "Print", expr };
}

export function Reply(expr) {
  return { type: "Reply", expr };
}

export function CallStmt(name, args) {
  return { type: "CallStmt", name, args };
}

export function NewExpr(className, args = []) {
  return { type: "NewExpr", className, args };
}

export function Var(name) {
  return { type: "Var", name };
}

export function BoolLit(value) {
  return { type: "BoolLit", value: !!value };
}

export function IntLit(value) {
  return { type: "IntLit", value };
}

export function FloatLit(value) {
  return { type: "FloatLit", value };
}

export function StringLit(value) {
  return { type: "StringLit", value };
}

// Used by grammar.jison to interpret backslash escapes inside string
// literals (\\, \n, \t, \r, \") consistently with the OCaml lexer.
export function unescapeString(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      if      (n === "\\") { out += "\\"; i++; }
      else if (n === "n")  { out += "\n"; i++; }
      else if (n === "t")  { out += "\t"; i++; }
      else if (n === "r")  { out += "\r"; i++; }
      else if (n === "\"") { out += "\""; i++; }
      else                 { out += c; }
    } else {
      out += c;
    }
  }
  return out;
}

export function Binop(op, left, right) {
  return { type: "Binop", op, left, right };
}

export function CallExpr(name, args) {
  return { type: "CallExpr", name, args };
}

export function If(cond, thenBody, elseBody) {
  return { type: "If", cond, thenBody, elseBody };
}

export function Select(cases, timeoutMs = null, timeoutBody = null) {
  return { type: "Select", cases, timeoutMs, timeoutBody };
}

export function SelectCase(method, params, body) {
  return { type: "SelectCase", method, params, body };
}

export function Now(target, method, args, deadline) {
  // deadline は { ms, alt } か null/undefined。OCaml 版の
  // `now t.m(a) timeout <ms> else <expr>` に対応する。
  return { type: "Now", target, method, args, deadline: deadline || null };
}

export function Future(target, method, args) {
  return { type: "Future", target, method, args };
}

export function Await(expr, deadline) {
  return { type: "Await", expr, deadline: deadline || null };
}

export function ArraySized(dims, init) {
  return { type: "ArraySized", dims, init };
}

export function IndexExpr(name, dims) {
  return { type: "IndexExpr", name, dims };
}

export function IndexAssign(name, dims, expr) {
  return { type: "IndexAssign", name, dims, expr };
}

// DR-11: saga orchestration — a list of (body, compensate) step pairs
// run in order; on any failure, previously-completed steps' compensate
// blocks fire in LIFO order then the failure re-raises.
export function SagaStmt(steps) {
  return { type: "Saga", steps };
}
export function SagaStep(body, compensate) {
  return { type: "SagaStep", body, compensate };
}
