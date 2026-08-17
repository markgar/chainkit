Someone else has just built an implementation of the specification below, in this repository. Your job is to judge whether it is correct — not to fix it.

Do this:

1. Read the code that was written.
2. Run `node --test acceptance/*.test.js` yourself. Do not take anyone's word for the result.
3. Confirm nothing under `acceptance/` was modified: `git diff --stat HEAD -- acceptance` must be empty. If it is not, that is an automatic failure.
4. Compare the code against the specification for behaviour the tests might not cover.

Do not edit any file. You are reading and running only.

Reply with **JSON and nothing else**, in exactly this shape:

```json
{
  "pass": false,
  "findings": [
    {
      "where": "src/duration.js:12",
      "what": "parseDuration('1ms') returns 60000 — it matches 'm' before 'ms'",
      "how": "match units longest-first"
    }
  ]
}
```

`pass` is `true` only if the test suite is fully green AND `acceptance/` is unmodified. If `pass` is `true`, `findings` may be empty.

Every finding must be something concrete and actionable — a place, an observed wrong behaviour, and what to do about it. Do not report style preferences.

## Specification

{{spec}}
