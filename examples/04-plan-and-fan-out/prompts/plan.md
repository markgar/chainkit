You are planning ONE small package before any code is written.

Read the spec below, then partition the work into CHUNKS that a cheap, fast builder
can transcribe without making a design decision.

Rules the plan must obey — these are not style, they are what makes the run
measurable:

- Each chunk OWNS a disjoint set of files. No two chunks may name the same file.
- Each chunk has exactly ONE acceptance command, and that command must pass with
  only that chunk's files present. A chunk whose completion depends on a later chunk
  cannot be graded when it is built.
- Chunks are ordered. Later chunks may assume earlier ones exist on disk.
- Every behaviour in the spec belongs to exactly one chunk.

The grader already exists in `acceptance/` in the working tree — READ IT. It is the
objective definition of done, and the acceptance command for each chunk must be the
suite that grades that chunk's file. Do not invent tests and do not modify
`acceptance/`.

## PRIOR REVIEW OF YOUR PLAN

{{planVerdict}}

---

## SPEC

{{spec}}

---

Return ONLY a JSON object, no prose around it:

{
  "chunks": [
    {
      "id": "c1",
      "name": "short human label",
      "files": ["src/foo.js"],
      "acceptance": "node --test acceptance/foo.test.js",
      "blueprint": "the exact signatures, behaviour and boundary cases the builder must transcribe — enough that no decision is left open"
    }
  ]
}
