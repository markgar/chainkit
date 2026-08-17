// REFERENCE. Recursive descent, matching the grammar in spec.md.
export function parse(tokens) {
  let i = 0;

  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const end = () => i >= tokens.length;

  function primary() {
    if (end()) throw new SyntaxError("unexpected end of input");
    const t = next();
    if (t.type === "num") return { type: "num", value: t.value };
    if (t.type === "lparen") {
      const inner = expr();
      if (end() || peek().type !== "rparen") throw new SyntaxError("expected )");
      next();
      return inner;
    }
    throw new SyntaxError(`unexpected token: ${t.type}`);
  }

  function factor() {
    if (!end() && peek().type === "op" && peek().value === "-") {
      next();
      return { type: "neg", operand: factor() };
    }
    return primary();
  }

  function term() {
    let left = factor();
    while (!end() && peek().type === "op" && (peek().value === "*" || peek().value === "/")) {
      const op = next().value;
      left = { type: "binary", op, left, right: factor() };
    }
    return left;
  }

  function expr() {
    let left = term();
    while (!end() && peek().type === "op" && (peek().value === "+" || peek().value === "-")) {
      const op = next().value;
      left = { type: "binary", op, left, right: term() };
    }
    return left;
  }

  const ast = expr();
  if (!end()) throw new SyntaxError(`unexpected trailing token: ${peek().type}`);
  return ast;
}
