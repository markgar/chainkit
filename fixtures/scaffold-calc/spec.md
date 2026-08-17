# Spec: `calc` — a zero-dependency arithmetic expression evaluator

Scaffold a small Node package from nothing. The working directory is empty except
for an `acceptance/` folder.

## Rules of the exercise

- **Do not modify, delete, or add anything under `acceptance/`.** Those tests are
  the grader. Changing them fails the run.
- No dependencies. No `npm install`. Standard library only.
- ES modules. Node 20+.

## Shape of the package

The work is deliberately split into four modules with one responsibility each.
Build them in this order — each depends on the one before it.

| #   | file              | exports    | grader                                    |
| --- | ----------------- | ---------- | ----------------------------------------- |
| 1   | `src/tokenize.js` | `tokenize` | `node --test acceptance/tokenize.test.js` |
| 2   | `src/parse.js`    | `parse`    | `node --test acceptance/parse.test.js`    |
| 3   | `src/evaluate.js` | `evaluate` | `node --test acceptance/evaluate.test.js` |
| 4   | `src/index.js`    | `calc`     | `node --test acceptance/calc.test.js`     |

All exports are **named** exports. Also create:

- `package.json` — name `calc`, `"type": "module"`, and a `test` script that runs
  `node --test acceptance/*.test.js`.
- `README.md` — a short usage section showing `calc("1 + 2 * 3")`.

---

## 1. `tokenize(src)` → array of tokens

Converts an expression string into a flat array of token objects.

**Token objects.** Exactly these shapes, exactly these keys:

- `{ type: "num", value: <number> }`
- `{ type: "op", value: "+" | "-" | "*" | "/" }`
- `{ type: "lparen" }`
- `{ type: "rparen" }`

**Numbers** are digits, optionally followed by `.` and more digits: `1`, `1.5`,
`0.25`. `value` is the parsed JavaScript number. **No sign, no exponent** — a
leading `-` is always an operator token, never part of the number. `1.` and `.5`
and `1e3` are invalid.

**Whitespace** (spaces and tabs) separates tokens and is otherwise ignored.

**Errors.** Throw a `SyntaxError` whose message is exactly:

- `` `unexpected character "<c>" at index <i>` `` — for any character that cannot
  start a token. `<i>` is the 0-based index in `src`.
- `` `malformed number at index <i>` `` — for a number with a trailing `.` and no
  digits after it (`1.`), where `<i>` is the index the number started at.

An empty or whitespace-only `src` returns `[]` — that is **not** an error here.

## 2. `parse(tokens)` → AST

Builds a tree from the token array. Standard precedence and associativity:

```
expr    := term (("+" | "-") term)*        // left-associative
term    := factor (("*" | "/") factor)*    // left-associative
factor  := "-" factor | primary            // unary minus, right-associative
primary := num | "(" expr ")"
```

**Node objects.** Exactly these shapes, exactly these keys:

- `{ type: "num", value: <number> }`
- `{ type: "binary", op: "+" | "-" | "*" | "/", left: <node>, right: <node> }`
- `{ type: "neg", operand: <node> }`

So `1 + 2 * 3` parses to
`{type:"binary", op:"+", left:{type:"num",value:1}, right:{type:"binary", op:"*", left:{type:"num",value:2}, right:{type:"num",value:3}}}`.

`-2` parses to `{type:"neg", operand:{type:"num", value:2}}`. `--2` is legal and
nests two `neg` nodes.

**Errors.** Throw a `SyntaxError` whose message is exactly:

- `unexpected end of input` — the tokens ran out mid-expression, including when
  `tokens` is empty.
- `` `unexpected token: <type>` `` — a token appeared where a primary was
  expected (e.g. an operator with nothing before it, other than unary minus).
  `<type>` is the token's `type` field.
- `expected )` — an opening paren was never closed.
- `` `unexpected trailing token: <type>` `` — tokens remain after a complete
  expression was parsed (e.g. `1 2`).

## 3. `evaluate(node)` → number

Walks the AST and computes a number.

- `num` → its `value`.
- `neg` → the negation of its operand.
- `binary` → the operation applied to the evaluated left and right.

**Errors.** Throw a `RangeError` with the exact message `division by zero` when
the right side of a `/` evaluates to `0`. (Both `0` and `-0` count as zero.)

Throw a `TypeError` with the exact message `` `unknown node type: <type>` `` for
any node whose `type` is not one of the three above.

## 4. `calc(src)` → number

The one-call front door: `tokenize`, then `parse`, then `evaluate`. It adds no
error handling of its own — errors from the three stages propagate unchanged.

`calc("")` therefore throws `unexpected end of input`, because `tokenize` returns
`[]` and `parse` rejects it.

---

## Worked examples

| input           | result                                |
| --------------- | ------------------------------------- |
| `"1 + 2 * 3"`   | `7`                                   |
| `"(1 + 2) * 3"` | `9`                                   |
| `"10 / 4"`      | `2.5`                                 |
| `"-3 + 5"`      | `2`                                   |
| `"2 * -3"`      | `-6`                                  |
| `"8 - 3 - 2"`   | `3` (left-associative, not `7`)       |
| `"100 / 5 / 2"` | `10` (left-associative, not `40`)     |
| `"1 / 0"`       | throws `RangeError: division by zero` |
