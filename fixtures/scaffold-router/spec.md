# Spec: `router` — a zero-dependency URL router

Scaffold a small Node package from nothing. The working directory contains an
`acceptance/` folder and a `package.json`, and nothing else.

## Rules of the exercise

- **Do not modify, delete, or add anything under `acceptance/`.** Those tests are
  the grader. Changing them fails the run.
- **`package.json` already exists. Do not modify it.**
- No dependencies. No `npm install`. Standard library only.
- ES modules. Node 20+.

## Shape of the package

Four modules, one responsibility each. They form a diamond: `match` and `build`
both consume what `compile` produces, and `router` composes all three.

| #   | file             | exports        | grader                                   |
| --- | ---------------- | -------------- | ---------------------------------------- |
| 1   | `src/compile.js` | `compile`      | `node --test acceptance/compile.test.js` |
| 2   | `src/match.js`   | `match`        | `node --test acceptance/match.test.js`   |
| 3   | `src/build.js`   | `build`        | `node --test acceptance/build.test.js`   |
| 4   | `src/router.js`  | `createRouter` | `node --test acceptance/router.test.js`  |

All exports are **named** exports.

`match` and `build` take an already-compiled route as their first argument. They
**must not import `compile.js`** — they operate on the data shape below, which is
fully specified here. `router.js` imports all three.

---

## The compiled-route shape

`compile` returns exactly this object, with exactly these keys:

```js
{
  segments: [ /* one entry per path segment, in order */ ],
  score: 0 // a number
}
```

Each entry in `segments` is exactly one of:

- `{ kind: "static", value: "<literal text>" }`
- `{ kind: "param", name: "<param name>" }`
- `{ kind: "wildcard" }`

---

## 1. `compile(pattern)` → compiled route

`pattern` is a string like `/users/:id/posts` or `/files/*`.

**Splitting.** Strip one leading `/` if present, strip one trailing `/` if
present, then split on `/`. The pattern `/` (or the empty string) compiles to
`segments: []`.

**Segment kinds.**

- A segment starting with `:` is a **param**; `name` is the rest of the segment.
- A segment that is exactly `*` is a **wildcard**.
- Anything else is a **static** segment; `value` is the segment text verbatim.

**Score** is the sum over segments: `3` for each static, `2` for each param, `1`
for each wildcard. `segments: []` scores `0`.

**Errors.** Throw a `SyntaxError` whose message is exactly:

- `` `empty segment in pattern "<pattern>"` `` — if any segment is the empty
  string after splitting (e.g. `/a//b`).
- `` `param with no name in pattern "<pattern>"` `` — for a bare `:` segment.
- `` `wildcard must be the last segment in pattern "<pattern>"` `` — if a
  wildcard appears anywhere but last.
- `` `duplicate param ":<name>" in pattern "<pattern>"` `` — if the same param
  name appears twice.

Checks are applied left to right, one segment at a time; the first failing
segment decides which error is thrown. The duplicate-param check happens as the
second occurrence is reached.

## 2. `match(compiled, path)` → `null` or `{ params }`

`compiled` is a compiled-route object. `path` is a string like `/users/7/posts`.

Split `path` exactly as `compile` splits a pattern (strip one leading and one
trailing `/`, then split on `/`). Unlike `compile`, an **empty segment in a path
is not an error** — it simply will not match a static or param segment, and
`"/"` yields `[]`.

**Matching.**

- A `static` segment matches only a path segment equal to its `value`.
- A `param` segment matches any **non-empty** path segment, and records
  `params[name] = <segment text>`.
- A `wildcard` matches **all remaining** path segments, including none, and
  records `params["*"] = <the remaining segments joined with "/">` (the empty
  string when none remain).

Without a wildcard the segment counts must be equal. On success return
`{ params }` — an object, empty when the route has no params. On any failure
return `null`. **Never throw.**

Path segments are compared verbatim: no case folding, no URL decoding.

## 3. `build(compiled, params)` → string

The reverse of `match`. Returns a path beginning with `/`.

- A `static` segment contributes its `value`.
- A `param` segment contributes `String(params[name])`.
- A `wildcard` contributes `String(params["*"])`, and is **omitted entirely**
  when `params["*"]` is absent or the empty string.

`segments: []` builds `"/"`. Otherwise the result is `"/"` followed by the
contributed segments joined with `"/"`.

**Errors.** Throw a `TypeError` whose message is exactly:

- `` `missing param ":<name>"` `` — when a param segment's name is absent from
  `params` (`undefined`, or `params` itself is null/undefined). An empty string
  is a **valid** value and must not throw.

## 4. `createRouter()` → router

```js
const r = createRouter();
r.add("GET", "/users/:id", handlerA); // returns the router, so calls chain
r.resolve("GET", "/users/7"); // -> { handler: handlerA, params: { id: "7" } }
```

- **`add(method, pattern, handler)`** compiles the pattern and stores the route.
  Returns the router itself. `method` is compared **case-insensitively** and is
  stored upper-cased.
- **`resolve(method, path)`** returns `{ handler, params }` for the best matching
  route, or `null` when nothing matches.
- **`routes()`** returns an array of `{ method, pattern, score }`, one per added
  route, in insertion order.

**Precedence.** Among routes that match, the highest `score` wins. On a tie the
route added **first** wins.

**Errors.** `add` propagates whatever `compile` throws. `resolve` never throws.
