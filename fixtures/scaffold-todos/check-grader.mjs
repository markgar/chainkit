// Does the grader actually admit a correct solution?
//
// The acceptance suite is the oracle for this job, and a wrong oracle is the worst
// failure a harness can have: every process fails, none of them for a reason that
// says anything about the process. So the suite is checked against a known-good
// reference implementation before it is ever used to judge anything.
//
// `reference/` is NEVER copied into a run's workdir (prep-workdir.mjs copies only
// `acceptance/`), so no process can see the answer.
//
// This already earned its keep: it caught that `node --test acceptance/` resolves
// as a module path and fails outright, which would have failed every run at the
// gate regardless of the code produced.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "grader-"));

try {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  cpSync(path.join(here, "acceptance"), path.join(dir, "acceptance"), { recursive: true });
  cpSync(path.join(here, "reference", "todos.js"), path.join(dir, "src", "todos.js"));
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "todos", type: "module" }, null, 2),
  );

  const out = execFileSync("bash", ["-o", "pipefail", "-c", "node --test acceptance/*.test.js"], {
    cwd: dir,
    encoding: "utf8",
  });
  const pass = /^# pass (\d+)$/m.exec(out)?.[1];
  const fail = /^# fail (\d+)$/m.exec(out)?.[1];
  if (fail !== "0" || !pass || Number(pass) === 0) {
    console.error(out);
    throw new Error(`grader is not satisfiable: pass=${pass} fail=${fail}`);
  }
  console.log(`grader check PASS — reference implementation passes ${pass} test(s)`);
} catch (err) {
  console.error(`grader check FAIL — ${err.message}`);
  if (err.stdout) console.error(err.stdout);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
