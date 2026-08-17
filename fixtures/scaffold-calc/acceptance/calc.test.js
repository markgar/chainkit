// GRADER — chunk 4: src/index.js, and the only suite that grades the modules
// working TOGETHER.
//
// Chunks 1-3 are each graded in isolation so blame is per-chunk. This one exists
// because three individually-correct modules can still be wired wrong, and nothing
// upstream would notice.
import test from "node:test";
import assert from "node:assert/strict";
import { calc } from "../src/index.js";

test("precedence", () => {
  assert.equal(calc("1 + 2 * 3"), 7);
});

test("parens", () => {
  assert.equal(calc("(1 + 2) * 3"), 9);
});

test("division produces a real quotient", () => {
  assert.equal(calc("10 / 4"), 2.5);
});

test("unary minus at the start", () => {
  assert.equal(calc("-3 + 5"), 2);
});

test("unary minus after an operator", () => {
  assert.equal(calc("2 * -3"), -6);
});

test("subtraction is left-associative end to end", () => {
  assert.equal(calc("8 - 3 - 2"), 3);
});

test("division is left-associative end to end", () => {
  assert.equal(calc("100 / 5 / 2"), 10);
});

test("decimals survive the whole pipeline", () => {
  assert.equal(calc("0.25 * 4"), 1);
});

test("nested parens", () => {
  assert.equal(calc("((1 + 2) * (3 + 4))"), 21);
});

test("whitespace is irrelevant", () => {
  assert.equal(calc("  1+2  *  3 "), 7);
});

// Errors propagate UNCHANGED -- a front door that wraps them in its own Error
// destroys the message every other suite pins.
test("a tokenizer error propagates unchanged", () => {
  assert.throws(() => calc("1 $ 2"), {
    name: "SyntaxError",
    message: 'unexpected character "$" at index 2',
  });
});

test("a parser error propagates unchanged", () => {
  assert.throws(() => calc("1 2"), {
    name: "SyntaxError",
    message: "unexpected trailing token: num",
  });
});

test("an evaluator error propagates unchanged", () => {
  assert.throws(() => calc("1 / 0"), { name: "RangeError", message: "division by zero" });
});

test("empty input reaches the parser and is rejected there", () => {
  assert.throws(() => calc(""), { name: "SyntaxError", message: "unexpected end of input" });
});

test("a long chain evaluates correctly", () => {
  assert.equal(calc("1 + 2 * 3 - 4 / 2"), 5);
});
