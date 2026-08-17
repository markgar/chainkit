You are working in an empty repository. The only thing in it is an `acceptance/` directory holding a test suite that grades your work.

Build what the specification below describes.

Rules:

- **Do not modify, delete, or add any file under `acceptance/`.** Those tests grade you. If they change, the run fails no matter how good the code is.
- No dependencies, no installs. Node's standard library only.
- Run `node --test acceptance/*.test.js` yourself, and keep working until every test passes. Do not stop at "it should work" — run it.
- Read the specification carefully before writing anything. It pins behaviour the tests check exactly: which error type is thrown for which bad input, which arguments are validated before which, and the rule that no function may modify what it was given.

When you are done, reply with a short summary of the files you created and the final test result.

## Specification

{{spec}}
