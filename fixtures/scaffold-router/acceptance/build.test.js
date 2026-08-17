import test from "node:test";
import assert from "node:assert/strict";
import { build } from "../src/build.js";

// Literals again, for the same reason as match.test.js: this suite grades
// src/build.js on its own.
const S = (value) => ({ kind: "static", value });
const P = (name) => ({ kind: "param", name });
const W = { kind: "wildcard" };
const route = (...segments) => ({ segments, score: 0 });

test("a route with no segments builds the root path", () => {
  assert.equal(build(route(), {}), "/");
});

test("static segments are joined under a leading slash", () => {
  assert.equal(build(route(S("users"), S("all")), {}), "/users/all");
});

test("params are substituted by name", () => {
  assert.equal(build(route(S("users"), P("id")), { id: "7" }), "/users/7");
});

test("a non-string param value is stringified", () => {
  assert.equal(build(route(P("id")), { id: 7 }), "/7");
});

test("an empty string is a valid param value", () => {
  assert.equal(build(route(S("a"), P("id")), { id: "" }), "/a/");
});

test("a missing param throws a TypeError naming it", () => {
  assert.throws(() => build(route(S("users"), P("id")), {}), {
    name: "TypeError",
    message: 'missing param ":id"',
  });
});

test("a null params object still throws for a required param", () => {
  assert.throws(() => build(route(P("id")), null), {
    name: "TypeError",
    message: 'missing param ":id"',
  });
});

test("a wildcard contributes its captured tail", () => {
  assert.equal(build(route(S("files"), W), { "*": "a/b" }), "/files/a/b");
});

test("an absent wildcard is omitted entirely", () => {
  assert.equal(build(route(S("files"), W), {}), "/files");
});

test("an empty wildcard is omitted entirely", () => {
  assert.equal(build(route(S("files"), W), { "*": "" }), "/files");
});

test("a wildcard alone with no tail builds the root path", () => {
  assert.equal(build(route(W), {}), "/");
});

test("params and a wildcard combine", () => {
  assert.equal(build(route(P("id"), W), { id: "7", "*": "x/y" }), "/7/x/y");
});

test("extra params are ignored", () => {
  assert.equal(build(route(P("id")), { id: "7", other: "z" }), "/7");
});
