// GRADER — chunk 2: src/parse.js
//
// Grades the AST shape and precedence only. It builds its token arrays BY HAND
// rather than calling tokenize, so a broken chunk 1 cannot make chunk 2 look
// broken -- per-chunk blame is the whole point of gating per chunk.
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parse.js";

const num = (value) => ({ type: "num", value });
const op = (value) => ({ type: "op", value });
const L = { type: "lparen" };
const R = { type: "rparen" };

test("a single number parses to a num node", () => {
  assert.deepEqual(parse([num(7)]), { type: "num", value: 7 });
});

test("addition builds a binary node", () => {
  assert.deepEqual(parse([num(1), op("+"), num(2)]), {
    type: "binary",
    op: "+",
    left: { type: "num", value: 1 },
    right: { type: "num", value: 2 },
  });
});

// The precedence trap: a flat left-to-right parser gives (1+2)*3 here.
test("multiplication binds tighter than addition", () => {
  assert.deepEqual(parse([num(1), op("+"), num(2), op("*"), num(3)]), {
    type: "binary",
    op: "+",
    left: { type: "num", value: 1 },
    right: {
      type: "binary",
      op: "*",
      left: { type: "num", value: 2 },
      right: { type: "num", value: 3 },
    },
  });
});

// The associativity trap: a right-associative parser gives 8-(3-2)=7.
test("subtraction is LEFT-associative", () => {
  assert.deepEqual(parse([num(8), op("-"), num(3), op("-"), num(2)]), {
    type: "binary",
    op: "-",
    left: {
      type: "binary",
      op: "-",
      left: { type: "num", value: 8 },
      right: { type: "num", value: 3 },
    },
    right: { type: "num", value: 2 },
  });
});

test("division is LEFT-associative", () => {
  const ast = parse([num(100), op("/"), num(5), op("/"), num(2)]);
  assert.equal(ast.op, "/");
  assert.equal(ast.left.type, "binary");
  assert.deepEqual(ast.right, { type: "num", value: 2 });
});

test("parens override precedence", () => {
  assert.deepEqual(parse([L, num(1), op("+"), num(2), R, op("*"), num(3)]), {
    type: "binary",
    op: "*",
    left: {
      type: "binary",
      op: "+",
      left: { type: "num", value: 1 },
      right: { type: "num", value: 2 },
    },
    right: { type: "num", value: 3 },
  });
});

test("unary minus builds a neg node", () => {
  assert.deepEqual(parse([op("-"), num(2)]), {
    type: "neg",
    operand: { type: "num", value: 2 },
  });
});

test("unary minus nests", () => {
  assert.deepEqual(parse([op("-"), op("-"), num(2)]), {
    type: "neg",
    operand: { type: "neg", operand: { type: "num", value: 2 } },
  });
});

test("unary minus binds tighter than multiplication", () => {
  assert.deepEqual(parse([num(2), op("*"), op("-"), num(3)]), {
    type: "binary",
    op: "*",
    left: { type: "num", value: 2 },
    right: { type: "neg", operand: { type: "num", value: 3 } },
  });
});

test("empty tokens is unexpected end of input", () => {
  assert.throws(() => parse([]), { name: "SyntaxError", message: "unexpected end of input" });
});

test("a dangling operator is unexpected end of input", () => {
  assert.throws(() => parse([num(1), op("+")]), {
    name: "SyntaxError",
    message: "unexpected end of input",
  });
});

test("an unclosed paren is reported as expected )", () => {
  assert.throws(() => parse([L, num(1)]), { name: "SyntaxError", message: "expected )" });
});

test("a leading binary operator is an unexpected token", () => {
  assert.throws(() => parse([op("*"), num(1)]), {
    name: "SyntaxError",
    message: "unexpected token: op",
  });
});

test("a stray close paren is an unexpected token", () => {
  assert.throws(() => parse([R]), { name: "SyntaxError", message: "unexpected token: rparen" });
});

// The trap: a parser that stops at the first complete expression silently accepts
// "1 2" and evaluates it as 1.
test("trailing tokens after a complete expression are rejected", () => {
  assert.throws(() => parse([num(1), num(2)]), {
    name: "SyntaxError",
    message: "unexpected trailing token: num",
  });
});

test("deep nesting parses", () => {
  const ast = parse([L, L, num(1), op("+"), num(2), R, op("*"), num(3), R]);
  assert.equal(ast.type, "binary");
  assert.equal(ast.op, "*");
});
