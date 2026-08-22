%lex
%s saga
%%
\s+                             /* skip */
"//"[^\n]*                      /* skip line comments */
"class"      return 'CLASS';
"method"     return 'METHOD';
"var"        return 'VAR';
"call"       return 'CALL';
"if"         return 'IF';
"else"       return 'ELSE';
"while"      return 'WHILE';
"do"         return 'DO';
"send!"      return 'UNSAFESEND';
"send"       return 'SEND';
"now"        return 'NOW';
"future"     return 'FUTURE';
"await"      return 'AWAIT';
"print"      return 'PRINT';
"reply"      return 'REPLY';
"new"        return 'NEW';
"remote"     return 'REMOTE';
"select"     return 'SELECT';
"case"       return 'CASE';
"timeout"    return 'TIMEOUT';
"saga"       { yy.__saga_depth = 0; this.begin('saga'); return 'SAGA'; }
<saga>"step"        return 'STEP';
<saga>"compensate"  return 'COMPENSATE';
"->"         return 'ARROW';
"++"         return 'CONCAT';
"true"       return 'TRUE';
"false"      return 'FALSE';
"=="         return 'EQ';
"!="         return 'NEQ';
"<="         return 'LE';
">="         return 'GE';
<saga>"{"  { yy.__saga_depth = (yy.__saga_depth | 0) + 1; return '{'; }
<saga>"}"  {
              yy.__saga_depth = (yy.__saga_depth | 0) - 1;
              if (yy.__saga_depth <= 0) { this.popState(); }
              return '}';
           }
"{"  return '{';
"}"  return '}';
"("  return '(';
")"  return ')';
";"  return ';';
":"  return ':';
"!"  return '!';
"@"  return 'AT';
","  return ',';
"."  return '.';
"="  return '=';
"["  return '[';
"]"  return ']';
"<"  return 'LT';
">"  return 'GT';
"+"  return '+';
"-"  return '-';
"*"  return '*';
"/"  return '/';
[0-9]+\.[0-9]*   return 'FLOAT';
[0-9]+\b         return 'INT';
\"[^\"]*\"       return 'STRING';
[a-zA-Z_][a-zA-Z0-9_]*  return 'IDENT';
<<EOF>>          return 'EOF';
/lex

%start program
/* Precedence stack, lowest to highest. The %nonassoc UAWAIT tag is
   used by the `AWAIT expr` rule so the prefix `await` doesn't create
   shift/reduce conflicts with following binops. Mirrors the
   OCaml-side parser.mly. */
%left EQ NEQ
%left LT GT LE GE
%left CONCAT
%left '+' '-'
%left '*' '/'
%right UMINUS
%nonassoc UAWAIT

%{
/* keep empty: use yy.X in actions */
%}

%%

program
  : class_decls stmts EOF
      { return yy.Program($1, $2); }
  ;

class_decls
  : class_decls class_decl
      { $$ = $1.concat([$2]); }
  |
      { $$ = []; }
  ;

class_decl
  : CLASS IDENT '{' class_members '}'
      {
        var fields  = $4.filter(function(m){ return m.type === 'VarField'; });
        var methods = $4.filter(function(m){ return m.type === 'MethodDecl'; });
        $$ = yy.ClassDecl($2, methods, fields);
      }
  ;

class_members
  : class_members class_member
      { $$ = $1.concat([$2]); }
  |
      { $$ = []; }
  ;

class_member
  : method_decl
      { $$ = $1; }
  | VAR IDENT '=' expr ';'
      { $$ = yy.VarField($2, $4); }
  | VAR IDENT dim_list ';'
      { $$ = yy.VarField($2, yy.ArraySized($3, null)); }
  | VAR IDENT dim_list '=' expr ';'
      { $$ = yy.VarField($2, yy.ArraySized($3, $5)); }
  ;

dim_list
  : '[' expr ']'                { $$ = [$2]; }
  | '[' expr ']' dim_list       { $$ = [$2].concat($4); }
  ;

method_decl
  : METHOD IDENT '(' params ')' opt_ret opt_level opt_eff '{' stmts '}'
      { var md = yy.MethodDecl($2, $4.map(function (p) { return p.name; }),
                               yy.Seq($10), $6, $8,
                               $4.map(function (p) { return p.ty; }));
        md.level = $7; $$ = md; }
  ;

/* 義務レベル `@ 3`。now/await は厳密に大きいレベルへしか向かえない。 */
opt_level
  : AT INT   { $$ = Number($2); }
  |          { $$ = null; }
  ;

/* 戻り値型注釈 `: T`（OCaml 版 parser.mly の opt_ret と同形）。
   ここでは型名を持つだけで、検査は typecheck.js の仕事。 */
opt_ret
  : ':' IDENT   { $$ = $2; }
  |             { $$ = null; }
  ;

/* 効果注釈 `!{a, b}`（OCaml 版の opt_eff）。 */
opt_eff
  : '!' '{' eff_list '}'  { $$ = $3; }
  |                       { $$ = null; }
  ;

eff_list
  : IDENT                 { $$ = [$1]; }
  | eff_list ',' IDENT    { $$ = $1.concat([$3]); }
  |                       { $$ = []; }
  ;

/* 引数は `x` でも `x: T` でも書ける（OCaml 版・Py-I と同じ）。
   型は名前として持つだけで、検査は typecheck.js の仕事。
   AST の params は従来どおり名前の配列にし、型は paramTypes に並べる
   ---- 既存の参照箇所を壊さないため。 */
params
  : param
      { $$ = [$1]; }
  | params ',' param
      { $$ = $1.concat([$3]); }
  |
      { $$ = []; }
  ;

param
  : IDENT             { $$ = { name: $1, ty: null }; }
  | IDENT ':' IDENT   { $$ = { name: $1, ty: $3 }; }
  /* reply は字句の段階で REPLY になるので、型注釈としては別に受ける */
  | IDENT ':' REPLY   { $$ = { name: $1, ty: "reply" }; }
  ;

stmts
  : stmts stmt
      { $$ = $1.concat([$2]); }
  |
      { $$ = []; }
  ;

stmt
  : VAR IDENT '=' expr ';'                       { $$ = yy.VarDecl($2, $4); }
  | VAR IDENT dim_list ';'                       { $$ = yy.VarDecl($2, yy.ArraySized($3, null)); }
  | VAR IDENT dim_list '=' expr ';'              { $$ = yy.VarDecl($2, yy.ArraySized($3, $5)); }
  | IDENT '=' expr ';'                           { $$ = yy.Assign($1, $3); }
  | IDENT dim_list '=' expr ';'                  { $$ = yy.IndexAssign($1, $2, $4); }
  | SEND IDENT '.' IDENT '(' args ')' ';'        { $$ = yy.Send($2, $4, $6, false); }
  /* メッシュの他ノードへ送る。宛先は "ノード/アクター" に解決する。 */
  | SEND REMOTE '(' STRING ',' STRING ')' '.' IDENT '(' args ')' ';'
      { $$ = yy.Send(yy.unescapeString($4.slice(1,-1)) + "/" +
                     yy.unescapeString($6.slice(1,-1)), $9, $11, false); }
  | UNSAFESEND IDENT '.' IDENT '(' args ')' ';'  { $$ = yy.Send($2, $4, $6, true); }
  | PRINT '(' expr ')' ';'                       { $$ = yy.Print($3); }
  | REPLY '(' expr ')' ';'                       { $$ = yy.Reply($3); }
  | CALL IDENT '(' args ')' ';'                  { $$ = yy.CallStmt($2, $4); }
  | IDENT '(' args ')' ';'                       { $$ = yy.CallStmt($1, $3); }
  | IF '(' expr ')' '{' stmts '}' else_opt       { $$ = yy.If($3, yy.Seq($6), $8); }
  | WHILE expr DO '{' stmts '}'                   { $$ = yy.While($2, yy.Seq($5)); }
  | SELECT '{' select_cases timeout_opt '}'      { $$ = yy.Select($3, $4.ms, $4.body); }
  | SAGA '{' saga_steps '}'                      { $$ = yy.SagaStmt($3); }
  ;

saga_steps
  : saga_steps saga_step                         { $$ = $1.concat([$2]); }
  | saga_step                                    { $$ = [$1]; }
  ;

saga_step
  : STEP '{' stmts '}' COMPENSATE '{' stmts '}'
      { $$ = yy.SagaStep(yy.Seq($3), yy.Seq($7)); }
  ;

else_opt
  : ELSE '{' stmts '}'
      { $$ = yy.Seq($3); }
  |
      { $$ = null; }
  ;

select_cases
  : select_cases select_case
      { $$ = $1.concat([$2]); }
  | select_case
      { $$ = [$1]; }
  ;

select_case
  : CASE IDENT '(' params ')' ARROW '{' stmts '}'
      /* params は {name, ty} の並びになったので、ここでは名前だけ取り出す。
         SelectCase.params を名前の配列のままにしておかないと、
         case 本体の束縛（localEnv[p]）がオブジェクトをキーにしてしまい、
         引数が見えなくなる。 */
      { $$ = yy.SelectCase($2, $4.map(function (p) { return p.name; }), yy.Seq($8)); }
  ;

timeout_opt
  : TIMEOUT INT ARROW '{' stmts '}'
      { $$ = { ms: Number($2), body: yy.Seq($5) }; }
  |
      { $$ = { ms: null, body: null }; }
  ;

args
  : expr
      { $$ = [$1]; }
  | args ',' expr
      { $$ = $1.concat([$3]); }
  |
      { $$ = []; }
  ;

expr
  : INT                       { $$ = yy.IntLit(Number(yytext)); }
  | FLOAT                     { $$ = yy.FloatLit(parseFloat(yytext)); }
  | STRING                    { $$ = yy.StringLit(yy.unescapeString(yytext.slice(1, -1))); }
  | IDENT                     { $$ = yy.Var($1); }
  | NEW IDENT '(' args ')'    { $$ = yy.NewExpr($2, $4); }
  | IDENT '(' args ')'        { $$ = yy.CallExpr($1, $3); }
  | NOW IDENT '.' IDENT '(' args ')'    { $$ = yy.Now($2, $4, $6); }
  | FUTURE IDENT '.' IDENT '(' args ')' { $$ = yy.Future($2, $4, $6); }
  | AWAIT expr %prec UAWAIT             { $$ = yy.Await($2); }
  | IDENT dim_list                      { $$ = yy.IndexExpr($1, $2); }
  | '(' expr ')'              { $$ = $2; }
  | TRUE                      { $$ = yy.BoolLit(true); }
  | FALSE                     { $$ = yy.BoolLit(false); }
  | NOW IDENT '.' IDENT '(' args ')' TIMEOUT INT ELSE expr
      { $$ = yy.Now($2, $4, $6, { ms: Number($9), alt: $11 }); }
  /* メッシュの他ノードへの now。宛先は "ノード/アクター" に解決する。 */
  | NOW REMOTE '(' STRING ',' STRING ')' '.' IDENT '(' args ')' TIMEOUT INT ELSE expr
      { $$ = yy.Now(yy.unescapeString($4.slice(1,-1)) + "/" +
                    yy.unescapeString($6.slice(1,-1)), $9, $11,
                    { ms: Number($14), alt: $16 }); }
  | NOW REMOTE '(' STRING ',' STRING ')' '.' IDENT '(' args ')' TIMEOUT INT
      { $$ = yy.Now(yy.unescapeString($4.slice(1,-1)) + "/" +
                    yy.unescapeString($6.slice(1,-1)), $9, $11,
                    { ms: Number($14), alt: null }); }
  /* else を書かない形。値は result<τ> になり、成功したかどうかを型で持つ。 */
  | NOW IDENT '.' IDENT '(' args ')' TIMEOUT INT
      { $$ = yy.Now($2, $4, $6, { ms: Number($9), alt: null }); }
  | AWAIT expr TIMEOUT INT ELSE expr %prec UAWAIT
      { $$ = yy.Await($2, { ms: Number($4), alt: $6 }); }
  | AWAIT expr TIMEOUT INT %prec UAWAIT
      { $$ = yy.Await($2, { ms: Number($4), alt: null }); }
  | '-' expr %prec UMINUS     { $$ = yy.Binop('-', yy.IntLit(0), $2); }
  | expr CONCAT expr          { $$ = yy.Binop('++', $1, $3); }
  | expr '+' expr             { $$ = yy.Binop('+', $1, $3); }
  | expr '-' expr             { $$ = yy.Binop('-', $1, $3); }
  | expr '*' expr             { $$ = yy.Binop('*', $1, $3); }
  | expr '/' expr             { $$ = yy.Binop('/', $1, $3); }
  | expr EQ  expr             { $$ = yy.Binop('==', $1, $3); }
  | expr NEQ expr             { $$ = yy.Binop('!=', $1, $3); }
  | expr LT  expr             { $$ = yy.Binop('<',  $1, $3); }
  | expr GT  expr             { $$ = yy.Binop('>',  $1, $3); }
  | expr LE  expr             { $$ = yy.Binop('<=', $1, $3); }
  | expr GE  expr             { $$ = yy.Binop('>=', $1, $3); }
  ;
