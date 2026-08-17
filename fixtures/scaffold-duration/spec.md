# Spec: `duration` — a zero-dependency duration string library

Scaffold a small Node package from nothing. The working directory is empty except
for an `acceptance/` folder.

## Rules of the exercise

- **Do not modify, delete, or add anything under `acceptance/`.** Those tests are
  the grader. Changing them fails the run.
- No dependencies. No `npm install`. Standard library only.
- ES modules.

## Files to create

- `package.json` — name `duration`, `"type": "module"`, and a `test` script that
  runs `node --test acceptance/*.test.js`.
- `src/duration.js` — exports `parseDuration` and `formatDuration` as **named**
  exports.
- `README.md` — a short usage section.

## `parseDuration(input)` → number of milliseconds

Input is a duration string. Output is an integer count of milliseconds.

**Grammar.** One or more `<number><unit>` pairs. Whitespace between pairs is
allowed and ignored. Leading and trailing whitespace is trimmed.

- A number is digits, optionally followed by `.` and more digits: `1`, `1.5`,
  `0.25`. **No sign. No exponent.** `1.` and `.5` and `1e3` are all invalid.
- A unit is one of `ms`, `s`, `m`, `h`, `d`, **lowercase only**.
- Units are matched **longest-first**: `1ms` is one millisecond, never `1m`
  followed by a stray `s`.

**Multipliers.** `ms` = 1, `s` = 1000, `m` = 60000, `h` = 3600000,
`d` = 86400000.

**Result.** Sum every pair, then `Math.round` the total.

**Order does not matter.** `30m1h` equals `1h30m`.

**Errors.**

- Input is not a string → throw `TypeError`.
- Input is a string but does not match the grammar → throw `SyntaxError`.
  This covers: empty or whitespace-only, a number with no unit (`100`), a unit
  with no number (`h`, `1hm`), an unknown unit (`1x`), an uppercase unit (`1H`),
  a negative sign (`-5m`), an exponent (`1e3s`), a malformed number (`1.h`).
- **A unit appearing more than once → throw `SyntaxError`** (`1h1h` is invalid,
  even though it is unambiguous).

## `formatDuration(ms)` → string

The inverse. Produces a string `parseDuration` accepts.

- Input must be a `number` → otherwise throw `TypeError`.
- It must be a **non-negative integer** → otherwise throw `RangeError`. This
  includes `-1`, `1.5`, `NaN`, and `Infinity`.
- `0` → `"0ms"`.
- Otherwise decompose largest unit first — `d`, `h`, `m`, `s`, `ms` — emitting
  `<number><unit>` for each **non-zero** component, concatenated with no
  separator. Zero components are omitted entirely: `3600000` is `"1h"`, not
  `"1h0m0s0ms"`.

**Round trip.** For every non-negative integer `n`,
`parseDuration(formatDuration(n)) === n`.

## Examples

| call                        | result          |
| --------------------------- | --------------- |
| `parseDuration("1h30m")`    | `5400000`       |
| `parseDuration("30m1h")`    | `5400000`       |
| `parseDuration("1h 30m")`   | `5400000`       |
| `parseDuration("1ms")`      | `1`             |
| `parseDuration("1.5h")`     | `5400000`       |
| `parseDuration("1.5ms")`    | `2`             |
| `parseDuration("0s")`       | `0`             |
| `formatDuration(0)`         | `"0ms"`         |
| `formatDuration(5400000)`   | `"1h30m"`       |
| `formatDuration(3600000)`   | `"1h"`          |
| `formatDuration(183845006)` | `"2d3h4m5s6ms"` |

## Done when

`node --test acceptance/*.test.js` passes with every test green, and `acceptance/` is
byte-for-byte unchanged.
