import test from "node:test";
import assert from "node:assert/strict";
import { match } from "../src/match.js";

// Compiled routes are written out as LITERALS on purpose. This suite grades
// src/match.js alone, so importing src/compile.js would make a defect in compile
// fail the match chunk -- and per-chunk blame is the whole point of the split.
const S = (value) => ({ kind: "static", value });
const P = (name) => ({ kind: "param", name });
const W = { kind: "wildcard" };
const route = (...segments) => ({ segments, score: 0 });

test("the root route matches only the root path", () => {
  assert.deepEqual(match(route(), "/"), { params: {} });
  assert.deepEqual(match(route(), ""), { params: {} });
  assert.equal(match(route(), "/a"), null);
});

test("static segments must match exactly", () => {
  assert.deepEqual(match(route(S("users")), "/users"), { params: {} });
  assert.equal(match(route(S("users")), "/Users"), null);
});

test("a leading slash is optional and one trailing slash is ignored", () => {
  assert.deepEqual(match(route(S("a")), "a"), { params: {} });
  assert.deepEqual(match(route(S("a")), "/a/"), { params: {} });
});

test("a param captures the segment text", () => {
  assert.deepEqual(match(route(S("users"), P("id")), "/users/7"), {
    params: { id: "7" },
  });
});

test("several params are all captured", () => {
  assert.deepEqual(match(route(P("a"), P("b")), "/x/y"), {
    params: { a: "x", b: "y" },
  });
});

test("a param does not match an empty segment", () => {
  assert.equal(match(route(S("a"), P("id")), "/a/"), null);
});

test("segment counts must be equal without a wildcard", () => {
  assert.equal(match(route(S("a")), "/a/b"), null);
  assert.equal(match(route(S("a"), S("b")), "/a"), null);
});

test("a wildcard captures the remaining segments joined by slash", () => {
  assert.deepEqual(match(route(S("files"), W), "/files/a/b/c"), {
    params: { "*": "a/b/c" },
  });
});

test("a wildcard matches zero remaining segments as the empty string", () => {
  assert.deepEqual(match(route(S("files"), W), "/files"), {
    params: { "*": "" },
  });
});

test("a wildcard is captured alongside earlier params", () => {
  assert.deepEqual(match(route(P("id"), W), "/7/deep/path"), {
    params: { id: "7", "*": "deep/path" },
  });
});

test("segments are compared verbatim, with no url decoding", () => {
  assert.deepEqual(match(route(P("id")), "/a%20b"), {
    params: { id: "a%20b" },
  });
});

test("a route with no params yields an empty params object", () => {
  const hit = match(route(S("a")), "/a");
  assert.deepEqual(hit.params, {});
});

test("a failure is null rather than a thrown error", () => {
  assert.equal(match(route(S("a")), "/b"), null);
  assert.doesNotThrow(() => match(route(S("a")), "/b"));
});

test("the result has exactly one key", () => {
  assert.deepEqual(Object.keys(match(route(P("id")), "/7")), ["params"]);
});
