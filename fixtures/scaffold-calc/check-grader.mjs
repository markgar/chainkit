// Does the grader actually admit a correct solution?
//
// The acceptance suites are the oracle for this job, and a wrong oracle is the
// worst failure a harness can have: every process fails, none of them for a reason
// that says anything about the process.
//
// `reference/` is NEVER copied into a run's workdir (prep-workdir.mjs copies only
// `acceptance/`), so no process can see the answer.
//
// This fixture is graded PER MODULE because the fan-out gates each chunk on its own
// command, so each suite is also checked ON ITS OWN here -- a suite that only passes
// once every module exists would be useless as a chunk gate, and running them all
// together would hide that.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Which modules each suite needs. Deliberately MINIMAL: chunks 1-3 are graded with
// only their own file present, which is the strong claim -- a suite that quietly
// needed a neighbouring module would blame chunk 2 for chunk 1's defect, and
// per-chunk blame is the entire reason to gate per chunk. Only the integration
// suite legitimately needs all four.
const SUITES = [
  ["tokenize", ["tokenize.js"]],
  ["parse", ["parse.js"]],
  ["evaluate", ["evaluate.js"]],
  ["calc", ["tokenize.js", "parse.js", "evaluate.js", "index.js"]],
];

let failed = 0;
let totalPass = 0;

for (const [suite, modules] of SUITES) {
  const dir = mkdtempSync(path.join(tmpdir(), `grader-calc-${suite}-`));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    cpSync(path.join(here, "acceptance"), path.join(dir, "acceptance"), { recursive: true });
    // ONLY the modules that suite legitimately needs. Copying all four would prove
    // the suite passes on a finished package, which is not the question.
    for (const m of modules) cpSync(path.join(here, "reference", m), path.join(dir, "src", m));
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "calc", type: "module" }, null, 2),
    );

    const cmd = `node --test acceptance/${suite}.test.js`;
    const out = execFileSync("bash", ["-o", "pipefail", "-c", cmd], { cwd: dir, encoding: "utf8" });
    const pass = /^# pass (\d+)$/m.exec(out)?.[1];
    const fail = /^# fail (\d+)$/m.exec(out)?.[1];
    if (fail !== "0" || !pass || Number(pass) === 0) {
      console.error(out);
      throw new Error(`pass=${pass} fail=${fail}`);
    }
    totalPass += Number(pass);
    console.log(
      `  ✓ ${suite.padEnd(9)} ${String(pass).padStart(2)} test(s) pass with only [${modules.join(", ")}]`,
    );
  } catch (err) {
    failed++;
    console.error(`  ✗ ${suite} — ${err.message}`);
    if (err.stdout) console.error(err.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  failed
    ? `grader check FAIL — ${failed} suite(s) not satisfiable`
    : `grader check PASS — ${totalPass} test(s) across ${SUITES.length} independently-gateable chunks`,
);
process.exitCode = failed ? 1 : 0;
