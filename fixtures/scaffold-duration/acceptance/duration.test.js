// GRADER. This file is the objective oracle for the scaffold-duration job: it is
// placed in the empty repo BEFORE the run, and the run is told not to touch it.
// The gate re-checks it is unmodified. Without that, a process could write its own
// weak tests, pass them, and score as a delivery -- a green it graded itself.
import test from "node:test";
import assert from "node:assert/strict";

import { parseDuration, formatDuration } from "../src/duration.js";

test("parseDuration: combined units", () => {
  assert.equal(parseDuration("1h30m"), 5400000);
  assert.equal(parseDuration("90m"), 5400000);
  assert.equal(parseDuration("60m1s"), 3601000);
  assert.equal(parseDuration("2d3h4m5s6ms"), 183845006);
});

test("parseDuration: unit order does not matter", () => {
  assert.equal(parseDuration("30m1h"), 5400000);
  assert.equal(parseDuration("6ms5s4m3h2d"), 183845006);
});

test("parseDuration: whitespace between pairs and around the string", () => {
  assert.equal(parseDuration("1h 30m"), 5400000);
  assert.equal(parseDuration("  1h  "), 3600000);
  assert.equal(parseDuration("1h\t30m"), 5400000);
});

test("parseDuration: ms wins over m followed by s (longest unit match)", () => {
  assert.equal(parseDuration("1ms"), 1);
  assert.equal(parseDuration("500ms"), 500);
});

test("parseDuration: every unit", () => {
  assert.equal(parseDuration("1ms"), 1);
  assert.equal(parseDuration("1s"), 1000);
  assert.equal(parseDuration("1m"), 60000);
  assert.equal(parseDuration("1h"), 3600000);
  assert.equal(parseDuration("1d"), 86400000);
});

test("parseDuration: decimals, and the total is rounded", () => {
  assert.equal(parseDuration("1.5h"), 5400000);
  assert.equal(parseDuration("0.25s"), 250);
  assert.equal(parseDuration("1.5ms"), 2);
  assert.equal(parseDuration("0.4ms"), 0);
});

test("parseDuration: zero is valid, not an error", () => {
  assert.equal(parseDuration("0s"), 0);
  assert.equal(parseDuration("0ms"), 0);
});

test("parseDuration: non-string input throws TypeError", () => {
  for (const bad of [100, null, undefined, {}, [], true, 1.5]) {
    assert.throws(() => parseDuration(bad), TypeError, `input ${String(bad)}`);
  }
});

test("parseDuration: malformed strings throw SyntaxError", () => {
  const bad = [
    "", // empty
    "   ", // whitespace only
    "100", // number with no unit
    "h", // unit with no number
    "1hm", // second unit has no number
    "1x", // unknown unit
    "1H", // uppercase unit
    "1Ms", // uppercase unit
    "-5m", // signed
    "+5m", // signed
    "1e3s", // exponent
    "1.h", // malformed number
    ".5h", // malformed number
    "1h;30m", // junk separator
    "1h30", // trailing number with no unit
  ];
  for (const s of bad) {
    assert.throws(() => parseDuration(s), SyntaxError, `input ${JSON.stringify(s)}`);
  }
});

test("parseDuration: a repeated unit throws SyntaxError", () => {
  assert.throws(() => parseDuration("1h1h"), SyntaxError);
  assert.throws(() => parseDuration("1h30m2h"), SyntaxError);
  assert.throws(() => parseDuration("1s 1s"), SyntaxError);
});

test("formatDuration: zero", () => {
  assert.equal(formatDuration(0), "0ms");
});

test("formatDuration: single components", () => {
  assert.equal(formatDuration(1), "1ms");
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(60000), "1m");
  assert.equal(formatDuration(3600000), "1h");
  assert.equal(formatDuration(86400000), "1d");
});

test("formatDuration: zero components are omitted", () => {
  assert.equal(formatDuration(5400000), "1h30m");
  assert.equal(formatDuration(61000), "1m1s");
  assert.equal(formatDuration(86400001), "1d1ms");
  assert.equal(formatDuration(183845006), "2d3h4m5s6ms");
});

test("formatDuration: non-number input throws TypeError", () => {
  for (const bad of ["5", null, undefined, {}, [], true]) {
    assert.throws(() => formatDuration(bad), TypeError, `input ${String(bad)}`);
  }
});

test("formatDuration: numbers that are not non-negative integers throw RangeError", () => {
  for (const bad of [-1, -0.5, 1.5, NaN, Infinity, -Infinity]) {
    assert.throws(() => formatDuration(bad), RangeError, `input ${String(bad)}`);
  }
});

test("round trip: parseDuration(formatDuration(n)) === n", () => {
  const values = [
    0, 1, 999, 1000, 1001, 59999, 60000, 3599999, 3600000, 5400000, 86399999, 86400000,
    183845006, 1234567890,
  ];
  for (const n of values) {
    assert.equal(parseDuration(formatDuration(n)), n, `round trip for ${n}`);
  }
});
