import test from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compile.js";

test("a root pattern has no segments and scores zero", () => {
  assert.deepEqual(compile("/"), { segments: [], score: 0 });
  assert.deepEqual(compile(""), { segments: [], score: 0 });
});

test("static segments are kept verbatim", () => {
  assert.deepEqual(compile("/users/all"), {
    segments: [
      { kind: "static", value: "users" },
      { kind: "static", value: "all" },
    ],
    score: 6,
  });
});

test("a leading slash is optional", () => {
  assert.deepEqual(compile("users"), compile("/users"));
});

test("one trailing slash is stripped", () => {
  assert.deepEqual(compile("/users/"), compile("/users"));
});

test("a colon segment becomes a named param", () => {
  assert.deepEqual(compile("/users/:id"), {
    segments: [
      { kind: "static", value: "users" },
      { kind: "param", name: "id" },
    ],
    score: 5,
  });
});

test("a bare star becomes a wildcard", () => {
  assert.deepEqual(compile("/files/*"), {
    segments: [{ kind: "static", value: "files" }, { kind: "wildcard" }],
    score: 4,
  });
});

test("a star inside a longer segment is static, not a wildcard", () => {
  assert.deepEqual(compile("/a*b"), {
    segments: [{ kind: "static", value: "a*b" }],
    score: 3,
  });
});

test("score sums 3 per static, 2 per param, 1 per wildcard", () => {
  assert.equal(compile("/a/:b/*").score, 6);
  assert.equal(compile("/:a/:b").score, 4);
});

test("an empty interior segment is rejected", () => {
  assert.throws(() => compile("/a//b"), {
    name: "SyntaxError",
    message: 'empty segment in pattern "/a//b"',
  });
});

test("a param with no name is rejected", () => {
  assert.throws(() => compile("/users/:"), {
    name: "SyntaxError",
    message: 'param with no name in pattern "/users/:"',
  });
});

test("a wildcard before the end is rejected", () => {
  assert.throws(() => compile("/*/tail"), {
    name: "SyntaxError",
    message: 'wildcard must be the last segment in pattern "/*/tail"',
  });
});

test("a repeated param name is rejected", () => {
  assert.throws(() => compile("/:id/x/:id"), {
    name: "SyntaxError",
    message: 'duplicate param ":id" in pattern "/:id/x/:id"',
  });
});

test("the first failing segment decides the error", () => {
  // The empty segment comes before the misplaced wildcard.
  assert.throws(() => compile("/a//*/b"), {
    message: 'empty segment in pattern "/a//*/b"',
  });
});

test("the returned object has exactly two keys", () => {
  assert.deepEqual(Object.keys(compile("/a/:b")).sort(), ["score", "segments"]);
});
