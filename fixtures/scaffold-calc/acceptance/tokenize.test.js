// GRADER — chunk 1: src/tokenize.js
//
// Each acceptance file grades exactly one module, because the fan-out gates each
// chunk on its own command. A single combined suite would fail for chunk 1 until
// chunk 4 landed, which makes a per-chunk gate meaningless.
import test from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/tokenize.js";

test("digits become a num token", () => {
  assert.deepEqual(tokenize("12"), [{ type: "num", value: 12 }]);
});

test("decimals parse to their numeric value", () => {
  assert.deepEqual(tokenize("1.5"), [{ type: "num", value: 1.5 }]);
  assert.deepEqual(tokenize("0.25"), [{ type: "num", value: 0.25 }]);
});

test("each operator becomes an op token", () => {
  assert.deepEqual(tokenize("+ - * /"), [
    { type: "op", value: "+" },
    { type: "op", value: "-" },
    { type: "op", value: "*" },
    { type: "op", value: "/" },
  ]);
});

test("parens are their own token types and carry no value key", () => {
  assert.deepEqual(tokenize("()"), [{ type: "lparen" }, { type: "rparen" }]);
});

test("whitespace separates but does not appear", () => {
  assert.deepEqual(tokenize("  1\t+\t2  "), [
    { type: "num", value: 1 },
    { type: "op", value: "+" },
    { type: "num", value: 2 },
  ]);
});

test("adjacent tokens need no whitespace", () => {
  assert.deepEqual(tokenize("1+2"), [
    { type: "num", value: 1 },
    { type: "op", value: "+" },
    { type: "num", value: 2 },
  ]);
});

// The trap: a tokenizer that folds the sign into the number makes "8 - 3" come out
// as two numbers, and every later stage then disagrees about what an expression is.
test("a leading minus is an OPERATOR, never part of the number", () => {
  assert.deepEqual(tokenize("-3"), [
    { type: "op", value: "-" },
    { type: "num", value: 3 },
  ]);
});

test("empty input is an empty token list, not an error", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
});

test("an unknown character throws SyntaxError naming the character and index", () => {
  assert.throws(() => tokenize("1 $ 2"), {
    name: "SyntaxError",
    message: 'unexpected character "$" at index 2',
  });
});

test("a trailing dot is a malformed number, reported at the number's start", () => {
  assert.throws(() => tokenize("1."), { name: "SyntaxError", message: "malformed number at index 0" });
});

test("a leading dot is an unexpected character", () => {
  assert.throws(() => tokenize(".5"), {
    name: "SyntaxError",
    message: 'unexpected character "." at index 0',
  });
});

test("an exponent is not a number, it is an unknown character", () => {
  assert.throws(() => tokenize("1e3"), {
    name: "SyntaxError",
    message: 'unexpected character "e" at index 1',
  });
});

test("the malformed-number index points at the number, not the dot", () => {
  assert.throws(() => tokenize("  12."), {
    name: "SyntaxError",
    message: "malformed number at index 2",
  });
});

test("a realistic expression tokenizes end to end", () => {
  assert.deepEqual(tokenize("(1 + 2) * 3"), [
    { type: "lparen" },
    { type: "num", value: 1 },
    { type: "op", value: "+" },
    { type: "num", value: 2 },
    { type: "rparen" },
    { type: "op", value: "*" },
    { type: "num", value: 3 },
  ]);
});
