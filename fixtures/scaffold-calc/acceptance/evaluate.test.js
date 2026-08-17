// GRADER — chunk 3: src/evaluate.js
//
// Builds ASTs by hand for the same reason parse.test.js builds tokens by hand: a
// broken earlier chunk must not be able to fail this chunk's gate.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/evaluate.js";

const num = (value) => ({ type: "num", value });
const bin = (op, left, right) => ({ type: "binary", op, left, right });
const neg = (operand) => ({ type: "neg", operand });

test("a num node evaluates to its value", () => {
  assert.equal(evaluate(num(7)), 7);
});

test("the four operators work", () => {
  assert.equal(evaluate(bin("+", num(1), num(2))), 3);
  assert.equal(evaluate(bin("-", num(5), num(2))), 3);
  assert.equal(evaluate(bin("*", num(4), num(3))), 12);
  assert.equal(evaluate(bin("/", num(10), num(4))), 2.5);
});

test("neg negates", () => {
  assert.equal(evaluate(neg(num(3))), -3);
});

test("nested neg cancels", () => {
  assert.equal(evaluate(neg(neg(num(3)))), 3);
});

test("evaluation recurses into both sides", () => {
  // 1 + 2 * 3
  assert.equal(evaluate(bin("+", num(1), bin("*", num(2), num(3)))), 7);
});

test("a deep tree evaluates", () => {
  // (1 + 2) * (10 / 5)
  assert.equal(evaluate(bin("*", bin("+", num(1), num(2)), bin("/", num(10), num(5)))), 6);
});

// The trap: JavaScript returns Infinity for x/0 rather than throwing, so an
// evaluator that just applies the operator produces a plausible non-number.
test("division by zero throws RangeError", () => {
  assert.throws(() => evaluate(bin("/", num(1), num(0))), {
    name: "RangeError",
    message: "division by zero",
  });
});

test("division by negative zero also throws", () => {
  assert.throws(() => evaluate(bin("/", num(1), num(-0))), {
    name: "RangeError",
    message: "division by zero",
  });
});

test("a zero divisor reached through a subtree still throws", () => {
  assert.throws(() => evaluate(bin("/", num(1), bin("-", num(3), num(3)))), {
    name: "RangeError",
    message: "division by zero",
  });
});

test("zero as a numerator is fine", () => {
  assert.equal(evaluate(bin("/", num(0), num(5))), 0);
});

test("an unknown node type throws TypeError naming the type", () => {
  assert.throws(() => evaluate({ type: "wat" }), {
    name: "TypeError",
    message: "unknown node type: wat",
  });
});

test("an unknown node type nested inside is still caught", () => {
  assert.throws(() => evaluate(bin("+", num(1), { type: "call" })), {
    name: "TypeError",
    message: "unknown node type: call",
  });
});
