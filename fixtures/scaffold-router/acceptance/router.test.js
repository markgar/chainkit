import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/router.js";

const h = (name) => () => name;

test("a resolved route returns its handler and params", () => {
  const a = h("a");
  const r = createRouter().add("GET", "/users/:id", a);
  assert.deepEqual(r.resolve("GET", "/users/7"), { handler: a, params: { id: "7" } });
});

test("add returns the router so calls chain", () => {
  const r = createRouter();
  assert.equal(r.add("GET", "/a", h("a")), r);
});

test("nothing matching resolves to null", () => {
  const r = createRouter().add("GET", "/a", h("a"));
  assert.equal(r.resolve("GET", "/b"), null);
});

test("the method must match", () => {
  const r = createRouter().add("GET", "/a", h("a"));
  assert.equal(r.resolve("POST", "/a"), null);
});

test("methods are compared case-insensitively", () => {
  const a = h("a");
  const r = createRouter().add("get", "/a", a);
  assert.equal(r.resolve("GET", "/a").handler, a);
  assert.equal(r.resolve("get", "/a").handler, a);
});

test("the higher-scoring route wins regardless of insertion order", () => {
  const param = h("param");
  const exact = h("exact");
  const r = createRouter().add("GET", "/users/:id", param).add("GET", "/users/me", exact);
  assert.equal(r.resolve("GET", "/users/me").handler, exact);
  assert.equal(r.resolve("GET", "/users/7").handler, param);
});

test("a static route still wins when it was added last", () => {
  const wild = h("wild");
  const exact = h("exact");
  const r = createRouter().add("GET", "/files/*", wild).add("GET", "/files/readme", exact);
  assert.equal(r.resolve("GET", "/files/readme").handler, exact);
});

test("on a score tie the route added first wins", () => {
  const first = h("first");
  const second = h("second");
  const r = createRouter().add("GET", "/:a", first).add("GET", "/:b", second);
  assert.equal(r.resolve("GET", "/x").handler, first);
});

test("a wildcard route captures the tail", () => {
  const r = createRouter().add("GET", "/files/*", h("w"));
  assert.deepEqual(r.resolve("GET", "/files/a/b").params, { "*": "a/b" });
});

test("routes lists what was added, in order, with scores", () => {
  const r = createRouter().add("get", "/users/:id", h("a")).add("POST", "/files/*", h("b"));
  assert.deepEqual(r.routes(), [
    { method: "GET", pattern: "/users/:id", score: 5 },
    { method: "POST", pattern: "/files/*", score: 4 },
  ]);
});

test("routers are independent of one another", () => {
  const r1 = createRouter().add("GET", "/a", h("a"));
  const r2 = createRouter();
  assert.equal(r2.resolve("GET", "/a"), null);
  assert.equal(r1.routes().length, 1);
  assert.equal(r2.routes().length, 0);
});

test("add propagates a bad pattern as a SyntaxError", () => {
  assert.throws(() => createRouter().add("GET", "/a//b", h("a")), { name: "SyntaxError" });
});

test("resolve never throws on an odd path", () => {
  const r = createRouter().add("GET", "/a/:id", h("a"));
  assert.doesNotThrow(() => r.resolve("GET", "/a//"));
  assert.equal(r.resolve("GET", "/a//"), null);
});

test("the root route resolves", () => {
  const root = h("root");
  const r = createRouter().add("GET", "/", root);
  assert.deepEqual(r.resolve("GET", "/"), { handler: root, params: {} });
});
